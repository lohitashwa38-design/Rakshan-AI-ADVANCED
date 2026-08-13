import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { QRCodeCanvas } from "qrcode.react";
import { signProfile } from "../utils/cryptoId";
import Spinner from "../components/Spinner";
import { Zap } from "lucide-react";
import { QrReader } from "react-qr-reader";

export default function DigitalID() {
  const [form, setForm] = useState({
    name: "",
    passport: "",
    aadhaar: "",
    destination: "",
    emergencyContact: "",
  });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [scanError, setScanError] = useState("");

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === "aadhaar") {
      // Only allow 12 digits
      if (!/^\d{0,12}$/.test(value)) return;
    }
    setForm({ ...form, [name]: value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      console.log("🛠️ SHIELD: Generating Secure ID...");
      const signedData = await signProfile(form);
      
      if (!signedData || typeof signedData !== 'object') {
        throw new Error("Invalid signature generated");
      }

      setResult({ ...signedData });
      localStorage.setItem("shield_id", JSON.stringify(signedData));
      console.log("✅ SHIELD: ID Generated Successfully.");
    } catch (err) {
      console.error("❌ SHIELD ID Sign Error:", err);
      setError("Cryptographic verification failed. This can happen in private browsing or if storage is full.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 md:p-12 flex flex-col items-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full bg-white/5 backdrop-blur-2xl border border-white/10 p-6 md:p-12 rounded-[2rem] md:rounded-[3rem] shadow-2xl overflow-hidden relative"
      >
        <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 blur-[100px] -z-10"></div>
        
        <div className="text-center mb-8 md:mb-12">
          <div className="flex items-center justify-center gap-3 mb-2">
            <h2 className="text-3xl md:text-5xl font-black text-white tracking-tight leading-tight">Decentralized Tourist ID</h2>
            <span className="px-2 py-1 bg-indigo-500 text-[8px] font-black rounded-md uppercase tracking-tighter">v2.0</span>
          </div>
          <p className="text-white/40 text-[10px] md:text-xs uppercase tracking-widest mt-1">Secured via Ed25519 Cryptographic Signatures</p>
        </div>
        
        <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-2 gap-8 md:gap-12">
          <div className="space-y-6 md:space-y-8">
            {["name", "passport", "aadhaar", "destination", "emergencyContact"].map((field) => (
              <div key={field} className="space-y-2">
                <label htmlFor={field} className="text-[10px] uppercase tracking-widest text-indigo-400 font-black ml-1">
                  {field === "aadhaar" ? "Aadhaar Number (12 Digits)" : field.replace(/([A-Z])/g, " $1")}
                </label>
                <input
                  id={field}
                  name={field}
                  type={field === "aadhaar" ? "text" : "text"}
                  inputMode={field === "aadhaar" ? "numeric" : "text"}
                  value={form[field]}
                  onChange={handleChange}
                  required
                  aria-required="true"
                  pattern={field === "aadhaar" ? "\\d{12}" : undefined}
                  title={field === "aadhaar" ? "Aadhaar number must be exactly 12 digits" : undefined}
                  placeholder={field === "aadhaar" ? "Enter 12-digit Aadhaar" : `Enter ${field}`}
                  className="w-full px-5 py-4 bg-white/5 border border-white/10 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all placeholder:text-white/10 text-sm text-white"
                />
              </div>
            ))}
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="w-full py-5 bg-indigo-600 hover:bg-indigo-500 rounded-2xl font-black text-lg shadow-xl transition-all flex items-center justify-center text-white focus:outline-none focus:ring-4 focus:ring-indigo-500/50"
            >
              {loading ? <Spinner /> : "Generate Secure ID"}
              <button type="button" onClick={() => setShowScanner(!showScanner)} className="ml-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-400 rounded-md text-sm font-medium text-white">{showScanner ? "Close Scanner" : "Scan QR"}</button>
            </motion.button>
          </div>

          <div className="flex flex-col justify-center items-center">
            <div className="w-full h-full min-h-[350px] border-2 border-dashed border-white/10 rounded-[2.5rem] flex flex-col items-center justify-center relative bg-black/20 p-8 shadow-inner">
              <AnimatePresence mode="wait">
                {showScanner && (
                  <div className="my-4 w-full max-w-md mx-auto">
                    <QrReader
                      constraints={{ facingMode: "environment" }}
                      onResult={(result, error) => {
                        if (!!result) {
                          try {
                            const data = JSON.parse(result?.text);
                            // Assume data contains same fields as form
                            setForm({
                              name: data.name || "",
                              passport: data.passport || "",
                              aadhaar: data.aadhaar || "",
                              destination: data.destination || "",
                              emergencyContact: data.emergencyContact || "",
                            });
                            setShowScanner(false);
                            setScanError("");
                          } catch (e) {
                            setScanError("Invalid QR data");
                          }
                        }
                        if (error) {
                          setScanError(error?.message || "Scan error");
                        }
                      }}
                    />
                    {scanError && <p className="mt-2 text-xs text-red-400">{scanError}</p>}
                  </div>
                )}
                {result ? (
                  <motion.div
                    key="result"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center gap-8 w-full"
                  >
                    <div className="p-4 md:p-6 bg-white rounded-[2rem] shadow-[0_0_50px_rgba(255,255,255,0.2)] max-w-full">
                      {result && (
                        <QRCodeCanvas 
                          value={`https://rakshan-ai-advanced.onrender.com/verify?data=${encodeURIComponent(JSON.stringify(result))}`} 
                          size={220}
                          style={{ width: '100%', height: 'auto', maxWidth: '220px' }}
                          level="M"
                          includeMargin={false}
                        />
                      )}
                    </div>
                    <div className="text-center w-full">
                      <div className="flex items-center justify-center gap-2 mb-2">
                        <div className="w-2 h-2 bg-emerald-400 rounded-full animate-ping" />
                        <p className="text-[10px] text-emerald-400 font-black uppercase tracking-widest">Offline Cryptographic Proof</p>
                      </div>
                      <p className="text-indigo-400 font-black text-xl">Signature Valid</p>
                      <div className="mt-4 bg-black/40 p-3 rounded-xl border border-white/5 text-left">
                        <p className="text-[8px] text-white/40 uppercase tracking-widest mb-1">Public Key Hash</p>
                        <p className="text-[10px] text-white/60 font-mono break-all line-clamp-1">{result.publicKey}</p>
                      </div>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key="placeholder"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center p-6 space-y-3"
                  >
                    <div className="w-16 h-16 border-2 border-indigo-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                      <div className="w-8 h-8 border-2 border-indigo-500/40 rounded-full animate-pulse" />
                    </div>
                    <p className="text-indigo-200/60 font-medium">Waiting for identity data...</p>
                    <p className="text-[10px] text-white/20 uppercase tracking-widest font-black">Offline Verification Protocol</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </form>

        {error && (
          <p className="mt-8 text-red-400 text-center bg-red-400/10 p-4 rounded-2xl border border-red-400/20 text-sm font-bold" role="alert">
            {error}
          </p>
        )}
      </motion.div>
      
      {result && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-12 flex flex-wrap justify-center gap-6"
        >
          <button
            onClick={() => window.print()}
            aria-label="Download or Print Secure ID"
            className="group px-10 py-4 bg-emerald-600 hover:bg-emerald-500 rounded-2xl font-black transition-all border border-emerald-400/20 text-sm uppercase tracking-widest text-white shadow-[0_0_30px_rgba(16,185,129,0.2)] hover:shadow-[0_0_40px_rgba(16,185,129,0.4)] focus:outline-none focus:ring-4 focus:ring-emerald-500/20 flex items-center gap-3"
          >
            <Zap className="w-4 h-4 text-emerald-300" />
            Download Secure ID
          </button>

          <button
            onClick={async () => {
              const { signDuressPanicToken } = await import("../utils/cryptoId");
              const duressToken = await signDuressPanicToken();
              setResult(duressToken);
              const { toast } = await import("sonner");
              toast.error("🚨 DURESS SIGNATURE GENERATED: Covert panic token embedded in QR code proof.", { duration: 6000 });
            }}
            aria-label="Generate Panic Duress Signature"
            className="group px-8 py-4 bg-rose-950/80 hover:bg-rose-900 border border-rose-500/40 rounded-2xl font-black transition-all text-xs uppercase tracking-widest text-rose-300 shadow-xl focus:outline-none focus:ring-4 focus:ring-rose-500/20 flex items-center gap-2"
          >
            <Zap className="w-4 h-4 text-rose-400 animate-ping" />
            Generate Panic/Duress Token
          </button>
        </motion.div>
      )}
    </div>
  );
}

