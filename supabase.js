// ==========================================
// 🗄️ קובץ תקשורת מרוכז עם Supabase
// ==========================================
const axios = require("axios");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";

const getSupabaseHeaders = () => ({
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json"
});

// דוגמה לפונקציה לשליפת נתונים או רישום משתמש
async function getUserData(phone) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const response = await axios.get(`${SUPABASE_URL}/rest/v1/users?phone=eq.${phone}`, {
      headers: getSupabaseHeaders(),
      timeout: 5000
    });
    return response.data?.[0] || null;
  } catch (err) {
    console.error("❌ שגיאה בשליפה מ-Supabase:", err.message);
    return null;
  }
}

// דוגמה לפונקציה לשמירת נתונים ב-Supabase
async function logInteraction(phone, prompt, response) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/logs`, {
      phone,
      prompt,
      response,
      created_at: new Date()
    }, {
      headers: getSupabaseHeaders(),
      timeout: 5000
    });
  } catch (err) {
    console.error("❌ שגיאה בשמירת לוג ב-Supabase:", err.message);
  }
}

module.exports = {
  getUserData,
  logInteraction
};
