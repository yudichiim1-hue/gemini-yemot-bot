// ==========================================
// 🗄️ קובץ תקשורת מרוכז עם Supabase
// ==========================================
const axios = require("axios");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://huxqndiiksdgnxcmmmmz.supabase.co/rest/v";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_ocXPjtF1EPDgoX5LdLHRkw_vKdENtfp";

const getSupabaseHeaders = () => ({
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  "Prefer": "return=minimal"
});

// 1. פונקציית שמירת שיחה לטבלה conversation_logs (כולל שם משתמש)
async function logConversation(phone, question, answer, model, userName) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !phone || phone === "default_user") return;
  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/conversation_logs`, {
      phone: String(phone),
      question,
      answer,
      model: model || "unknown",
      user_name: userName || null
    }, {
      headers: getSupabaseHeaders(),
      timeout: 5000
    });
    console.log(`💾 השיחה נשמרה בהצלחה ב-Supabase עבור מספר: ${phone}`);
  } catch (err) {
    console.error("❌ שגיאה בשמירת שיחה ל-Supabase:", err.message);
  }
}

// 2. פונקציית שליפת השיחה האחרונה מאותו היום
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

// 3. פונקציית שליפת כל השיחות מאותו היום (עבור סיכום ופרופיל משתמש)
async function getAllConversationsForToday(phone) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !phone || phone === "default_user") return [];
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const isoToday = todayStart.toISOString();

    const queryUrl = `${SUPABASE_URL}/rest/v1/conversation_logs?phone=eq.${phone}&created_at=gte.${isoToday}&order=id.asc`;
    
    const response = await axios.get(queryUrl, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`
      },
      timeout: 5000
    });

    return response.data || [];
  } catch (err) {
    console.error("❌ שגיאה בשליפת כל השיחות מ-Supabase:", err.message);
    return [];
  }
}

// 4. פונקציית שליפת השם האחרון שהמשתמש הגדיר היום
async function getLatestUserNameForToday(phone) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !phone || phone === "default_user") return null;
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const isoToday = todayStart.toISOString();

    const queryUrl = `${SUPABASE_URL}/rest/v1/conversation_logs?phone=eq.${phone}&created_at=gte.${isoToday}&user_name=not.is.null&order=id.desc&limit=1`;
    
    const response = await axios.get(queryUrl, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`
      },
      timeout: 5000
    });

    if (response.data && response.data.length > 0) {
      return response.data[0].user_name;
    }
    return null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  logConversation,
  getLatestConversationForToday,
  getAllConversationsForToday,
  getLatestUserNameForToday
};
