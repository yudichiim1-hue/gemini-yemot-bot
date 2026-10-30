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

// 1. שמירת שיחה (כולל שם ועיר)
async function logConversation(phone, question, answer, model, userName, userCity) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !phone || phone === "default_user") return;
  try {
    await axios.post(`${SUPABASE_URL}/conversation_logs`, {
      phone: String(phone),
      question,
      answer,
      model: model || "unknown",
      user_name: userName || null,
      user_city: userCity || null
    }, {
      headers: getSupabaseHeaders(),
      timeout: 5000
    });
  } catch (err) {}
}

// 2. שליפת השיחה האחרונה להיום
async function getLatestConversationForToday(phone) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !phone || phone === "default_user") return null;
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const response = await axios.get(`${SUPABASE_URL}/conversation_logs?phone=eq.${phone}&created_at=gte.${todayStart.toISOString()}&order=id.desc&limit=1`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      timeout: 5000
    });
    return response.data?.[0] || null;
  } catch (err) {
    return null;
  }
}

// 3. שליפת כל השיחות להיום עבור משתמש ספציפי
async function getAllConversationsForToday(phone) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !phone || phone === "default_user") return [];
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const response = await axios.get(`${SUPABASE_URL}/conversation_logs?phone=eq.${phone}&created_at=gte.${todayStart.toISOString()}&order=id.asc`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      timeout: 5000
    });
    return response.data || [];
  } catch (err) {
    return [];
  }
}

// 4. שליפת שם משתמש מעודכן
async function getLatestUserNameForToday(phone) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !phone || phone === "default_user") return null;
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const response = await axios.get(`${SUPABASE_URL}/conversation_logs?phone=eq.${phone}&created_at=gte.${todayStart.toISOString()}&user_name=not.is.null&order=id.desc&limit=1`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      timeout: 5000
    });
    return response.data?.[0]?.user_name || null;
  } catch (err) {
    return null;
  }
}

// 5. שליפת עיר משתמש מעודכנת
async function getLatestUserCityForToday(phone) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !phone || phone === "default_user") return null;
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const response = await axios.get(`${SUPABASE_URL}/conversation_logs?phone=eq.${phone}&created_at=gte.${todayStart.toISOString()}&user_city=not.is.null&order=id.desc&limit=1`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      timeout: 5000
    });
    return response.data?.[0]?.user_city || null;
  } catch (err) {
    return null;
  }
}

// 6. שליפת הפעילויות האחרונות במערכת (עבור מצב מנהל)
async function getAllSystemConversationsForToday() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const response = await axios.get(`${SUPABASE_URL}/conversation_logs?created_at=gte.${todayStart.toISOString()}&order=id.desc&limit=5`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      timeout: 5000
    });
    return response.data || [];
  } catch (err) {
    return [];
  }
}

// 7. שליפת שיחות לפי 4 הספרות האחרונות
async function getConversationsByLast4Digits(last4Digits) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !last4Digits) return [];
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const response = await axios.get(`${SUPABASE_URL}/conversation_logs?created_at=gte.${todayStart.toISOString()}&order=id.desc&limit=50`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      timeout: 5000
    });
    const allLogs = response.data || [];
    return allLogs.filter(log => log.phone && String(log.phone).endsWith(last4Digits));
  } catch (err) {
    return [];
  }
}

module.exports = {
  logConversation,
  getLatestConversationForToday,
  getAllConversationsForToday,
  getLatestUserNameForToday,
  getLatestUserCityForToday,
  getAllSystemConversationsForToday,
  getConversationsByLast4Digits
};
