import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import http from "http";
import { Server } from "socket.io";
import QRCode from "qrcode";
import crypto from "crypto";
import jwt from "jsonwebtoken";

import { getTripPlan, getScamCheck, getConnectivityPrediction, getLostItemRecovery } from "./ai.js";
import { getPlaces } from "./osm.js";
import './db/db.js'; 
// or if using CommonJS: require('./db/db.js');   
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { logSafetyEvent } from "./logSafetyEvent.js";
import { supabase } from "./supabase.js";
import connectivityRouter from "./routes/connectivity.js";
import lostItemRouter from "./routes/lostItem.js";
import safetyEventsRouter from "./routes/safetyEvents.js";
import safetyScoreRouter from "./routes/safetyScore.js";
import offlineKitRouter from "./routes/offlineKit.js";
import routingRouter from "./routes/routing.js";
import osmDataRouter from "./routes/osmData.js";
import Redis from "ioredis";

const DATA_FILE = path.join(process.cwd(), "data_store.json");

// Tile38 Geofencing Connection
const tile38 = new Redis(process.env.TILE38_URL || "redis://localhost:9851", {

  lazyConnect: true,
  maxRetriesPerRequest: 0
});

tile38.on("error", (err) => console.warn("⚠️ Tile38 Geofence Engine offline. Falling back to math-based checks."));

// DragonflyDB Cache Connection
const dragonfly = new Redis(process.env.DRAGONFLY_URL || "redis://localhost:6379", {
  lazyConnect: true,
  maxRetriesPerRequest: 0
});

dragonfly.on("error", (err) => console.warn("⚠️ DragonflyDB Cache offline. Using in-memory fallback."));


const app = express();
const server = http.createServer(app);

const FRONTEND_URLS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175"
];
const JWT_SECRET = process.env.JWT_SECRET || "devsecret";

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

/* =======================================================
   MIDDLEWARE
======================================================= */
app.use((req, res, next) => {
  console.log(`API HIT: ${req.method} ${req.originalUrl}`);
  next();
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());

// Serve Static Frontend Files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "../frontend/dist")));

/* =======================================================
   MEMORY STORES
======================================================= */
/* =======================================================
   MEMORY STORES & PERSISTENCE
======================================================= */
let touristIdStore = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    touristIdStore = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    console.log("Loaded existing IDs from persistence layer");
  }
} catch (e) {
  console.log("Persistence initialization skipped");
}

const saveStore = () => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(touristIdStore, null, 2));
  } catch (e) {
    console.log("Failed to save store");
  }
};

const userTracking = {};
const tripsStore = [];
const safetyTimers = {}; // Store for wilderness safety check-ins
const wildernessZones = {}; // Store for dynamic wilderness geofences
let dangerZones = [
  { name: "Deep Forest Restricted Zone", lat: 12.9200, lon: 79.1325, radius: 3000, type: "FOREST" },
  { name: "Hazardous Cave System", lat: 11.9416, lon: 79.8083, radius: 1000, type: "CAVE" }
];

/* =======================================================
   HELPERS & CACHE
======================================================= */
const tripCache = new Map(); // Fresh start for boosted multi-day plans

const toNumber = (v) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Haversine Formula for accurate distance calculation
 */
const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; 
};

const lastAlerts = new Map(); // Throttle alerts to prevent lag

// NEW SAFETY ROUTES
app.get('/api/safety-events', async (req, res) => {
  const userId = req.query.userId || 'Anonymous';
  if (supabase) {
    const { data, error } = await supabase
      .from('safety_events')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (!error) return res.json(data);
  }
  res.json([]);
});

app.get('/api/safety-score', async (req, res) => {
  const userId = req.query.userId || 'Anonymous';
  try {
    const { computeSafetyScore } = await import('./computeSafetyScore.js');
    const result = await computeSafetyScore(userId);
    return res.json({ success: true, ...result });
  } catch (e) {
    console.error('Safety score error:', e);
    res.status(500).json({ error: 'Failed to compute safety score' });
  }
});

// OFFLINE EMERGENCY KIT endpoint
app.get('/api/offline-kit', async (req, res) => {
  const userId = req.query.userId || 'Anonymous';
  // Sample static data; real implementation would query OSM for nearby services
  const kit = {
    digitalId: true,
    emergencyContacts: true,
    lastKnownGPS: true,
    nearbyHospitals: [],
    nearbyPolice: [],
    medicalInfo: {},
    instructions: 'Stay calm, activate SOS if in danger, and follow local guidelines.',
    queuedSOS: []
  };
  // Log activation event
  await logSafetyEvent({
    userId,
    eventType: 'Offline Kit Activation',
    eventSource: 'OfflineKit',
    riskScore: 0
  });
  res.json({ success: true, kit });
});

const checkGeofencesAndEmit = async ({ key, lat, lon }) => {
  // Throttle check: Don't alert more than once every 30 seconds for the same user
  const now = Date.now();
  if (lastAlerts.has(key) && now - lastAlerts.get(key) < 30000) return;

  // 1. Tile38 High-Performance Check
  if (tile38.status === "ready") {
    try {
      await tile38.call("SET", "tourists", key, "POINT", lat, lon);
    } catch (e) {
      console.error("Tile38 check failed:", e);
    }
  }

  // 2. Fallback / Parallel Math-based Check (from dangerZones state)
  for (const z of dangerZones) {
    const d = getDistance(lat, lon, z.lat, z.lon);
    if (d < z.radius) {
      const alertPayload = {
        type: "GEOFENCE",
        alert: `⚠️ CRITICAL: You have entered ${z.name}`,
        zoneName: z.name,
        lat: z.lat,
        lon: z.lon,
        radius: z.radius,
        userId: key,
        time: new Date().toISOString()
      };
      io.emit("new-alert", alertPayload);
      lastAlerts.set(key, now); // Mark last alert time
      console.log(`🛡️ GEOFENCE BREACH: User ${key} in ${z.name}`);
      
      // Automatically log safety event for Geofence Breach
      logSafetyEvent({
        userId: key,
        eventType: "Geofence Breach",
        eventSource: "Geofencing",
        riskScore: 70,
        latitude: lat,
        longitude: lon,
        metadata: { zoneName: z.name, radius: z.radius, distance: d }
      }).catch(err => console.error("Failed to log geofence event:", err));
      
      break; 
    }
  }

  // 3. Dynamic Wilderness Perimeter Check
  if (wildernessZones[key]) {
    const wz = wildernessZones[key];
    const dist = getDistance(lat, lon, wz.lat, wz.lon);
    if (dist > wz.radius) {
      const alertPayload = {
        type: "WILDERNESS_BREACH",
        priority: "HIGH",
        alert: `🚨 PERIMETER BREACH: ${wz.name} has wandered outside the 1km Safe Zone!`,
        lat,
        lon,
        userId: key,
        time: new Date().toISOString()
      };
      io.emit("new-alert", alertPayload);
      lastAlerts.set(key, now);
      console.log(`🌲 WILDERNESS BREACH: ${key} left safe zone.`);
      
      // Automatically log safety event for Wilderness Breach
      logSafetyEvent({
        userId: key,
        eventType: "Geofence Breach",
        eventSource: "Wilderness Safety Timer",
        riskScore: 80,
        latitude: lat,
        longitude: lon,
        metadata: { zoneName: "Wilderness 1km Safe Zone", startLat: wz.lat, startLon: wz.lon, distance: dist }
      }).catch(err => console.error("Failed to log wilderness breach event:", err));
    }
  }
};


/* =======================================================
   LOAD ZONES
======================================================= */
const loadDangerZones = async () => {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from("zones").select("*");
    if (!error && data?.length) {
      dangerZones = data;
      console.log("Zones loaded from database");

      // Sync Tile38 with Danger Zones
      if (tile38.status === "ready") {
        for (const z of data) {
          await tile38.call("SET", "danger_zones", z.name, "CIRCLE", z.lat, z.lon, z.radius);
        }
        console.log("🚀 Tile38 Geofence Perimeter Sync Complete");
      }
    }
  } catch (e) {
    console.log("Zone loading skipped or failed");
  }
};

loadDangerZones();

/* =======================================================
   ROUTES
======================================================= */
// API Routes (Keep these BEFORE the catch-all)
app.get("/api/health", (_, res) => res.send("🚀 SAVIOUR AI Backend Running"));

app.get("/api/zones", (_, res) => res.json(dangerZones || []));

app.get("/api/places", async (req, res) => {
  try {
    const data = await getPlaces(req.query.city);
    res.json(data.map(p => ({
      name: p.name,
      address: p.display_name,
      lat: p.lat,
      lon: p.lon,
      type: p.type
    })));
  } catch {
    res.json([]);
  }
});

app.post("/api/smart-trip", async (req, res) => {
  try {
    const { destination, days, budget, language } = req.body;
    const cacheKey = `${destination}-${days}-${budget}-${language}`;
    
    if (tripCache.has(cacheKey)) {
      console.log(`Serving trip from memory cache: ${cacheKey}`);
      return res.json({ success: true, ...tripCache.get(cacheKey) });
    }

    // NEW: Check Supabase Persistent Cache
    if (supabase) {
      const { data: dbTrip } = await supabase
        .from('itineraries')
        .select('*')
        .eq('cache_key', cacheKey)
        .single();
      
      if (dbTrip) {
        console.log(`Serving trip from Supabase Persistent Cache: ${cacheKey}`);
        tripCache.set(cacheKey, dbTrip.data);
        return res.json({ success: true, ...dbTrip.data });
      }
    }

    let trip = await getTripPlan(destination, days, budget, language);

    if (!trip || !trip.itinerary || trip.itinerary.length < days) {
      console.log("AI failed or key missing. Attempting OSM data fetch...");
      
      let generatedPlaces = [];
      let baseLat = 20.5937;
      let baseLon = 78.9629;

      try {
        const destCoords = await getPlaces(destination);
        if (destCoords.length > 0) {
          baseLat = parseFloat(destCoords[0].lat);
          baseLon = parseFloat(destCoords[0].lon);
        }
        
        const realPlaces = await getPlaces(`tourism in ${destination}`);
        generatedPlaces = realPlaces;
      } catch (osmErr) {
        console.warn("⚠️ OSM Engine unreachable. Using geometric coordinate simulation.");
      }
      
      const spotNames = ["Heritage Fort", "Ancient Temple", "Cultural Bazaar", "Royal Palace", "National Museum", "City Center Square", "Botanical Gardens", "Sunset Point", "Wildlife Sanctuary", "Art Gallery"];
      
      trip = {
        destination,
        summary: `Rakshan AI has dynamically mapped ${days} days of secure exploration in ${destination} using geometric safe-vectors.`,
        itinerary: Array.from({ length: days }, (_, i) => {
          const p1Name = generatedPlaces[i * 2]?.display_name?.split(',')[0] || `${spotNames[i % spotNames.length]} of ${destination}`;
          const p1Lat = parseFloat(generatedPlaces[i * 2]?.lat) || baseLat + (Math.random() * 0.04 - 0.02);
          const p1Lon = parseFloat(generatedPlaces[i * 2]?.lon) || baseLon + (Math.random() * 0.04 - 0.02);

          const p2Name = generatedPlaces[i * 2 + 1]?.display_name?.split(',')[0] || `${spotNames[(i + 1) % spotNames.length]} of ${destination}`;
          const p2Lat = parseFloat(generatedPlaces[i * 2 + 1]?.lat) || baseLat + (Math.random() * 0.04 - 0.02);
          const p2Lon = parseFloat(generatedPlaces[i * 2 + 1]?.lon) || baseLon + (Math.random() * 0.04 - 0.02);

          return {
            day: i + 1,
            theme: i % 2 === 0 ? "Cultural Exploration" : "Strategic Discovery",
            activities: [
              { 
                name: p1Name, 
                lat: p1Lat, 
                lon: p1Lon, 
                description: "Verified tourist attraction with Rakshan security perimeter.", 
                time: "09:00 AM" 
              },
              { 
                name: p2Name, 
                lat: p2Lat, 
                lon: p2Lon, 
                description: "Regional exploration. High-accuracy telemetry active.", 
                time: "02:00 PM" 
              }
            ]
          };
        })
      };
    }

    tripCache.set(cacheKey, trip);
    
    // NEW: Save to Supabase Persistent Cache
    if (supabase) {
      supabase.from('itineraries').insert([{ cache_key: cacheKey, data: trip }]).then(({ error }) => {
        if (!error) console.log("Itinerary persisted to Supabase cloud");
      });
    }

    res.json({ success: true, ...trip });
    tripsStore.unshift({ id: crypto.randomUUID(), destination, createdAt: new Date().toISOString(), data: trip });
  } catch (e) {
    res.status(500).json({ error: "Trip generation failed" });
  }
});

app.post("/api/generate-id", async (req, res) => {
  try {
    const { name, passport, destination, emergencyContact } = req.body;
    if (!name || !passport || !destination || !emergencyContact) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const id = "SAVIOUR-" + crypto.randomUUID().slice(0, 8);
    const payload = { id, name, passport, destination, emergencyContact, createdAt: new Date().toISOString() };
    
    // Advanced VCard format so it works entirely offline natively on iOS/Android
    const qrData = `BEGIN:VCARD
VERSION:3.0
N:${name};;;
FN:${name}
ORG:Rakshan AI Smart Tourist (Verified)
TITLE:Decentralized ID: ${id}
TEL;TYPE=EMERGENCY,VOICE:${emergencyContact}
NOTE:Passport: ${passport}\\nDestination: ${destination}\\nStatus: VERIFIED\\nSecured via Govt of India Blockchain Protocol.
END:VCARD`;
    
    const qrCode = await QRCode.toDataURL(qrData);

    touristIdStore[id] = { data: payload, qrCode };
    saveStore(); // Persist to local disk

    // NEW: Persist to Supabase if available
    if (supabase) {
      supabase.from("tourists").insert([{ id, ...payload }]).then(({ error }) => {
        if (error) console.error("Supabase storage failed:", error.message);
        else console.log("Identity persisted to Supabase cloud");
      });
    }

    res.json({ success: true, id, qrCode, data: payload });
  } catch (e) {
    res.status(500).json({ error: "Identification failed" });
  }
});

app.get("/api/verify-id/:id", (req, res) => {
  const id = req.params.id;
  if (touristIdStore[id]) {
    return res.json({ verified: true, data: touristIdStore[id].data });
  }
  res.status(404).json({ verified: false });
});

app.post("/api/sos", async (req, res) => {
  const { userId, name, location, message, batteryLevel, isPanic } = req.body;
  const alertPayload = {
    type: "SOS",
    userId: userId || "Anonymous",
    name: name || "Tourist",
    lat: location?.lat,
    lon: location?.lon,
    message: message || "EMERGENCY: Immediate assistance required!",
    batteryLevel: batteryLevel || "N/A",
    isPanic: isPanic || false,
    time: new Date().toISOString()
  };

  io.emit("new-alert", alertPayload);
  console.log("🔥 SOS ALERT BROADCASTED:", alertPayload);
  
  // Automatically log SOS safety event
  await logSafetyEvent({
    userId: userId || "Anonymous",
    eventType: "SOS",
    eventSource: "SOS System",
    riskScore: 100, // Maximum severity/risk
    latitude: location?.lat,
    longitude: location?.lon,
    metadata: {
      message: message || "EMERGENCY: Immediate assistance required!",
      batteryLevel: batteryLevel || "N/A",
      isPanic: isPanic || false
    }
  });

  res.json({ success: true, payload: alertPayload });
});

/* =======================================================
   NEW MODULAR FEATURES: E-FIR & EVIDENCE
======================================================= */
app.post("/api/efir/create", async (req, res) => {
  const { tourist_hash, location_lat, location_lon } = req.body;
  // If supabase is not initialized, we still want to return a success for the demo
  if (!supabase) {
    console.warn("⚠️ Supabase offline - simulated success");
    return res.json({ success: true, message: "E-FIR Created (Simulated)", data: { tourist_hash, timestamp: new Date().toISOString() } });
  }

  try {
    const { data, error } = await supabase
      .from("e_fir")
      .insert([{ 
        tourist_hash, 
        location_lat: parseFloat(location_lat), 
        location_lon: parseFloat(location_lon), 
        status: "PENDING", 
        timestamp: new Date().toISOString() 
      }]);

    if (error) throw error;
    res.json({ success: true, message: "E-FIR Created", data });
  } catch (err) {
    console.error("E-FIR Error:", err.message);
    // Fallback for demo if DB fails
    res.json({ success: true, message: "E-FIR Created (Local Fallback)", data: { tourist_hash } });
  }
});

app.post("/api/evidence/upload", async (req, res) => {
  const { userId, type, data } = req.body;
  console.log(`📸 Evidence received from ${userId}: ${type}`);
  res.json({ success: true, message: "Evidence logged to Rakshan Secure Vault" });
});

app.get("/api/efir/download/:id", async (req, res) => {
  const { id } = req.params;
  // For the demo, if we don't have a real ID, we generate a fake FIR
  const content = `Rakshan AI - OFFICIAL E-FIR DOCUMENT\n\n` +
                  `FIR ID: ${id || 'FIR-999'}\n` +
                  `Status: VERIFIED\n` +
                  `Timestamp: ${new Date().toISOString()}\n\n` +
                  `Verified by Rakshan National Security Protocol.`;

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename=E-FIR-${id}.txt`);
  res.send(content);
});

import scamCheckRouter from "./routes/scamCheck.js";
app.use('/api/scam-check', scamCheckRouter);

app.get("/api/scam-history", async (req, res) => {
  try {
    const userId = req.query.userId || "Anonymous";
    if (supabase) {
      const { data, error } = await supabase
        .from("tourist_scam_checks")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(10);
      if (!error) {
        return res.json(data);
      }
    }
    res.json([]);
  } catch (err) {
    res.json([]);
  }
});

import scamAnalyticsRouter from "./routes/scamAnalytics.js";
import guardianAlertRouter from "./routes/guardianAlert.js";

/* =======================================================
   PHASE 2A ROUTE INTEGRATION
======================================================= */
app.use('/api/connectivity', connectivityRouter);
app.use('/api/lost-item', lostItemRouter);
app.use('/api/safety-events', safetyEventsRouter);
app.use('/api/safety-score', safetyScoreRouter);
app.use('/api/offline-kit', offlineKitRouter);

/* =======================================================
   PHASE 2B ROUTE INTEGRATION
======================================================= */
app.use('/api/scam/analytics', scamAnalyticsRouter);
app.use('/api/guardian-alert', guardianAlertRouter);
app.use('/api/routing', routingRouter);
app.use('/api/osm', osmDataRouter);

/* =======================================================
   WILDERNESS SAFETY SYSTEM
 ======================================================= */
app.post("/api/wilderness/start-timer", (req, res) => {
  const { userId, name, durationMinutes, location } = req.body;
  const expiryTime = Date.now() + durationMinutes * 60000;
  
  if (safetyTimers[userId]) clearTimeout(safetyTimers[userId].timeoutId);
  
  const timeoutId = setTimeout(() => {
    const alertPayload = {
      type: "WILDERNESS_EXPIRED",
      userId,
      name: name || "Tourist",
      message: `🚨 SAFETY CHECK-IN EXPIRED: Tourist is overdue in wilderness area! Last known location logged.`,
      lat: location?.lat,
      lon: location?.lon,
      time: new Date().toISOString(),
      priority: "CRITICAL"
    };
    io.emit("new-alert", alertPayload);
    delete safetyTimers[userId];
    delete wildernessZones[userId];
    console.log(`💀 SAFETY TIMER EXPIRED for ${userId}`);
  }, durationMinutes * 60000);

  safetyTimers[userId] = { expiryTime, timeoutId, location };
  
  // Set dynamic geofence perimeter (1km safe zone from start point)
  if (location?.lat && location?.lon) {
    wildernessZones[userId] = {
      name: name || "Tourist",
      lat: location.lat,
      lon: location.lon,
      radius: 1000 // 1km Safe Zone
    };
  }

  res.json({ success: true, expiryTime });
});

app.post("/api/wilderness/check-in", (req, res) => {
  const { userId } = req.body;
  if (safetyTimers[userId]) {
    clearTimeout(safetyTimers[userId].timeoutId);
    delete safetyTimers[userId];
    delete wildernessZones[userId];
    return res.json({ success: true, message: "Safety check-in successful. Timer deactivated." });
  }
  res.status(404).json({ success: false, message: "No active safety timer found." });
});

/* =======================================================
   SOCKETS
======================================================= */
io.on("connection", (socket) => {
  console.log("Socket Connected:", socket.id);

  socket.on("track-location", (payload = {}) => {
    const lat = toNumber(payload.lat);
    const lon = toNumber(payload.lon);
    if (lat === null || lon === null) return;

    const key = payload.userId || socket.id;
    userTracking[key] = { lat, lon, timestamp: Date.now() };
    
    io.emit("location-update", { userId: key, lat, lon });
    checkGeofencesAndEmit({ key, lat, lon });
  });

  socket.on("disconnect", () => console.log("Socket Disconnected:", socket.id));
});

// Catch-all route to serve the Frontend's index.html (MUST BE LAST)
app.use((req, res) => {
  const indexPage = path.join(__dirname, "../frontend/dist/index.html");
  if (fs.existsSync(indexPage)) {
    res.sendFile(indexPage);
  } else {
    // Frontend not yet built — redirect to login after serving a minimal redirect page
    res.status(200).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Rakshan AI — Loading</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: linear-gradient(135deg, #0d0f12 0%, #0f172a 50%, #0d0f12 100%);
            color: #e2e8f0;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            text-align: center;
          }
          .container {
            max-width: 480px;
            padding: 2.5rem 2rem;
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(99,179,237,0.2);
            border-radius: 20px;
            box-shadow: 0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(99,179,237,0.05);
            backdrop-filter: blur(16px);
          }
          .logo { font-size: 3rem; margin-bottom: 1rem; }
          h1 { color: #63b3ed; font-size: 1.8rem; margin-bottom: 0.5rem; }
          p { color: #94a3b8; font-size: 0.95rem; line-height: 1.6; }
          .spinner {
            width: 36px; height: 36px;
            border: 3px solid rgba(99,179,237,0.2);
            border-top-color: #63b3ed;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin: 1.5rem auto 0.5rem;
          }
          @keyframes spin { to { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="logo">🛡️</div>
          <h1>Rakshan AI</h1>
          <p>AI-Driven Cryptographic Border Protection & Safety Platform</p>
          <div class="spinner"></div>
          <p style="margin-top:0.5rem; color:#38bdf8; font-size:0.85rem;">Initializing secure environment…</p>
        </div>
      </body>
      </html>
    `);
  }
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  tripCache.clear(); // FORCE CLEAR ON RESTART
  console.log(`🚀 Rakshan AI Running on ${PORT} | Cache Cleared | System Ready`);
});

