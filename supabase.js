// ==========================================
// 🗄️ קובץ חיבור ופעולות מול Supabase
// ==========================================

const axios = "axios" in globalThis ? globalThis.axios : require("axios");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://huxqndiiksdgnxcmmmmz.supabase.co/rest/v1/";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_ocXPjtF1EPDgoX5LdLHRkw_vKdENtfp";

const supabase = {
  // רישום שיחה חדשה במסד הנתונים עם דיבוג שגיאות מלא
  async logConversation(phone, question, answer, model, userName = null, userCity = null) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.error("❌ חסרים SUPABASE_URL או SUPABASE_KEY");
      return;
    }
    try {
      await axios.post(`${SUPABASE_URL}/conversation_logs`, {
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

  // בדיקה האם מספר טלפון חסום במסד הנתונים
  async isUserBanned(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return false;
    try {
      const response = await axios.get(`${SUPABASE_URL}/banned_users?phone=eq.${phone}&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
        timeout: 5000
      });
      return response.data && response.data.length > 0;
    } catch (err) {
      return false;
    }
  },

  // הוספת מספר טלפון לרשימת החסומים במסד הנתונים
  async banUser(phone, reason = "חריגה מכללי השימוש") {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return false;
    try {
      await axios.post(`${SUPABASE_URL}/banned_users`, {
        phone: phone,
        reason: reason
      }, {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates"
        },
        timeout: 5000
      });
      return true;
    } catch (err) {
      console.error("❌ Error banning user:", err.response?.data || err.message);
      return false;
    }
  },

  // הסרת חסימה ממספר טלפון
  async unbanUser(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return false;
    try {
      await axios.delete(`${SUPABASE_URL}/banned_users?phone=eq.${phone}`, {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`
        },
        timeout: 5000
      });
      return true;
    } catch (err) {
      console.error("❌ Error unbanning user:", err.response?.data || err.message);
      return false;
    }
  },

  // שליפת השיחה האחרונה להיום עבור מספר ספציפי
  async getLatestConversationForToday(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return null;
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      
      const response = await axios.get(`${SUPABASE_URL}/conversation_logs?phone=eq.${phone}&created_at=gte.${todayStart.toISOString()}&order=id.desc&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
        timeout: 5000
      });
      return response.data && response.data.length > 0 ? response.data[0] : null;
    } catch (err) {
      return null;
    }
  },

  // שליפת כל השיחות להיום עבור מספר ספציפי
  async getAllConversationsForToday(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return [];
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
  },

  // שליפת הפעילויות האחרונות במערכת
  async getAllSystemConversationsForToday() {
    if (!SUPABASE_URL || !SUPABASE_KEY) return [];
    try {
      const response = await axios.get(`${SUPABASE_URL}/conversation_logs?order=id.desc&limit=10`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
        timeout: 5000
      });
      return response.data || [];
    } catch (err) {
      return [];
    }
  },

  // שליפת שיחות לפי 4 ספרות (שולף את ה-50 האחרונות ומסנן מקומית)
  async getConversationsByLast4Digits(last4) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !last4) return [];
    try {
      const response = await axios.get(`${SUPABASE_URL}/conversation_logs?order=id.desc&limit=50`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
        timeout: 5000
      });
      
      const allLogs = response.data || [];
      const matched = allLogs.filter(item => item.phone && String(item.phone).endsWith(last4));
      return matched.slice(0, 3);
    } catch (err) {
      return [];
    }
  },

  // שליפת שם משתמש אחרון להיום
  async getLatestUserNameForToday(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return null;
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const response = await axios.get(`${SUPABASE_URL}/conversation_logs?phone=eq.${phone}&created_at=gte.${todayStart.toISOString()}&user_name=not.is.null&order=id.desc&limit=1`, {
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

      const response = await axios.get(`${SUPABASE_URL}/conversation_logs?phone=eq.${phone}&created_at=gte.${todayStart.toISOString()}&user_city=not.is.null&order=id.desc&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
        timeout: 5000
      });
      return response.data && response.data.length > 0 ? response.data[0].user_city : null;
    } catch (err) {
      return null;
    }
  }
};

module.exports = supabase;
