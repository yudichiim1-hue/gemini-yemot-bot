const axios = "axios" in globalThis ? globalThis.axios : require("axios");

// הסרת סלאש מיותר בסוף הכתובת למניעת כפילות
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://huxqndiiksdgnxcmmmmz.supabase.co/rest/v1").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_ocXPjtF1EPDgoX5LdLHRkw_vKdENtfp";

const supabase = {
  // רישום שיחה חדשה במסד הנתונים עם דיבוג שגיאות מלא
  async logConversation(phone, question, answer, model, userName = null, userCity = null) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.error("❌ חסרים SUPABASE_URL או SUPABASE_KEY");
      return;
    }
    try {
      const endpoint = `${SUPABASE_URL}/conversation_logs`;
      await axios.post(endpoint, {
        phone: phone || "unknown",
        question: question || "",
        answer: answer || "",
        model: model || "unknown",
        user_name: userName,
        user_city: userCity
      }, {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        timeout: 5000
      });
      console.log("✅ לוג נשמר בהצלחה ב-Supabase");
    } catch (err) {
      console.error("❌ Supabase log error details:", err.response?.data || err.message);
    }
  },

  // שליפת השיחה האחרונה להיום עבור מספר ספציפי
  async getLatestConversationForToday(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return null;
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      
      const endpoint = `${SUPABASE_URL}/conversation_logs?phone=eq.${phone}&created_at=gte.${todayStart.toISOString()}&order=id.desc&limit=1`;
      const response = await axios.get(endpoint, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
        timeout: 5000
      });
      return response.data && response.data.length > 0 ? response.data[0] : null;
    } catch (err) {
      console.error("❌ Supabase getLatest error:", err.response?.data || err.message);
      return null;
    }
  },

  // שליפת כל השיחות להיום עבור מספר ספציפי
  async getAllConversationsForToday(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return [];
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const endpoint = `${SUPABASE_URL}/conversation_logs?phone=eq.${phone}&created_at=gte.${todayStart.toISOString()}&order=id.asc`;
      const response = await axios.get(endpoint, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
        timeout: 5000
      });
      return response.data || [];
    } catch (err) {
      console.error("❌ Supabase getAllToday error:", err.response?.data || err.message);
      return [];
    }
  },

  // שליפת הפעילויות האחרונות במערכת
  async getAllSystemConversationsForToday() {
    if (!SUPABASE_URL || !SUPABASE_KEY) return [];
    try {
      const endpoint = `${SUPABASE_URL}/conversation_logs?order=id.desc&limit=10`;
      const response = await axios.get(endpoint, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
        timeout: 5000
      });
      return response.data || [];
    } catch (err) {
      console.error("❌ Supabase getSystemLogs error:", err.response?.data || err.message);
      return [];
    }
  },

  // שליפת שיחות לפי 4 ספרות (שולף את ה-50 האחרונות ומסנן מקומית)
  async getConversationsByLast4Digits(last4) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !last4) return [];
    try {
      const endpoint = `${SUPABASE_URL}/conversation_logs?order=id.desc&limit=50`;
      const response = await axios.get(endpoint, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
        timeout: 5000
      });
      
      const allLogs = response.data || [];
      const matched = allLogs.filter(item => item.phone && String(item.phone).endsWith(last4));
      return matched.slice(0, 3);
    } catch (err) {
      console.error("❌ Supabase 4Digits error:", err.response?.data || err.message);
      return [];
    }
  },

  // שליפת שם משתמש אחרון להיום
  async getLatestUserNameForToday(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return null;
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const endpoint = `${SUPABASE_URL}/conversation_logs?phone=eq.${phone}&created_at=gte.${todayStart.toISOString()}&user_name=not.is.null&order=id.desc&limit=1`;
      const response = await axios.get(endpoint, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
        timeout: 5000
      });
      return response.data && response.data.length > 0 ? response.data[0].user_name : null;
    } catch (err) {
      return null;
    }
  },

  // שליפת עיר משתמש אחרונה להיום
  async getLatestUserCityForToday(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return null;
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const endpoint = `${SUPABASE_URL}/conversation_logs?phone=eq.${phone}&created_at=gte.${todayStart.toISOString()}&user_city=not.is.null&order=id.desc&limit=1`;
      const response = await endpoint ? axios.get(endpoint, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
        timeout: 5000
      }) : null;
      return response && response.data && response.data.length > 0 ? response.data[0].user_city : null;
    } catch (err) {
      return null;
    }
  }
};

module.exports = supabase;
