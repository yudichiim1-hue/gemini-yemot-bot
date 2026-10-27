// ==========================================
// 🗄️ קובץ תקשורת מרוכז עם Supabase
// ==========================================
const axios = require("axios");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://huxqndiiksdgnxcmmmmz.supabase.co/rest/v1/";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_ocXPjtF1EPDgoX5LdLHRkw_vKdENtfp";

const getSupabaseHeaders = () => ({
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  "Prefer": "return=minimal"
});

// פונקציית שמירת שיחה לטבלה conversation_logs
async function logConversation(phone, question, answer, model) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !phone || phone === "default_user") return;
  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/conversation_logs`, {
      phone: String(phone),
      question,
      answer,
      model: model || "unknown"
    }, {
      headers: getSupabaseHeaders(),
      timeout: 5000
    });
    console.log(`💾 השיחה נשמרה בהצלחה ב-Supabase עבור מספר: ${phone}`);
  } catch (err) {
    console.error("❌ שגיאה בשמירת שיחה ל-Supabase:", err.message);
  }
}

// פונקציית שליפת השיחה האחרונה מאותו היום עבור מספר טלפון
async function getLatestConversationForToday(phone) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !phone || phone === "default_user") return null;
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const isoToday = todayStart.toISOString();

    const queryUrl = `${SUPABASE_URL}/rest/v1/conversation_logs?phone=eq.${phone}&created_at=gte.${isoToday}&order=id.desc&limit=1`;
    
    const response = await axios.get(queryUrl, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`
      },
      timeout: 5000
    });

    if (response.data && response.data.length > 0) {
      return response.data[0];
    }
    return null;
  } catch (err) {
    console.error("❌ שגיאה בשליפת שיחה מ-Supabase:", err.message);
    return null;
  }
}

module.exports = {
  logConversation,
  getLatestConversationForToday
};
