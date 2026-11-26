// ==========================================
// 🗄️ קובץ חיבור ופעולות מול Supabase
// ==========================================

const axios = "axios" in globalThis ? globalThis.axios : require("axios");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://shjhpqeacfwzejsmqtpf.supabase.co/rest/v1").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_DG490EpeEGCtRWTmkumdnQ_Nt_sCUCn";

function getHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

function daysAgoIso(days = 14) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const supabase = {
  async logConversation(phone, question, answer, model, userName = null, userCity = null) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.error("❌ חסרים SUPABASE_URL או SUPABASE_KEY");
      return;
    }
    try {
      await axios.post(
        `${SUPABASE_URL}/conversation_logs`,
        {
          phone: phone || "unknown",
          question: question || "",
          answer: answer || "",
          model: model || "unknown",
          user_name: userName,
          user_city: userCity
        },
        {
          headers: getHeaders({ Prefer: "return=minimal" }),
          timeout: 5000
        }
      );
      console.log("✅ לוג נשמר בהצלחה ב-Supabase");
    } catch (err) {
      console.error("❌ Supabase log error details:", err.response?.data || err.message);
    }
  },

  async isUserBanned(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return false;
    try {
      const response = await axios.get(
        `${SUPABASE_URL}/banned_users?phone=eq.${encodeURIComponent(phone)}&limit=1`,
        { headers: getHeaders(), timeout: 5000 }
      );
      return Array.isArray(response.data) && response.data.length > 0;
    } catch (err) {
      return false;
    }
  },

  async banUser(phone, reason = "חריגה מכללי השימוש") {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return false;
    try {
      await axios.post(
        `${SUPABASE_URL}/banned_users`,
        { phone, reason },
        {
          headers: getHeaders({ Prefer: "resolution=merge-duplicates" }),
          timeout: 5000
        }
      );
      return true;
    } catch (err) {
      console.error("❌ Error banning user:", err.response?.data || err.message);
      return false;
    }
  },

  async unbanUser(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return false;
    try {
      await axios.delete(
        `${SUPABASE_URL}/banned_users?phone=eq.${encodeURIComponent(phone)}`,
        { headers: getHeaders(), timeout: 5000 }
      );
      return true;
    } catch (err) {
      console.error("❌ Error unbanning user:", err.response?.data || err.message);
      return false;
    }
  },

  async getLatestConversationForToday(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return null;
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const response = await axios.get(
        `${SUPABASE_URL}/conversation_logs?phone=eq.${encodeURIComponent(phone)}&created_at=gte.${encodeURIComponent(todayStart.toISOString())}&order=id.desc&limit=1`,
        { headers: getHeaders(), timeout: 5000 }
      );
      return response.data && response.data.length > 0 ? response.data[0] : null;
    } catch (err) {
      return null;
    }
  },

  async getAllConversationsForToday(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return [];
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const response = await axios.get(
        `${SUPABASE_URL}/conversation_logs?phone=eq.${encodeURIComponent(phone)}&created_at=gte.${encodeURIComponent(todayStart.toISOString())}&order=id.asc`,
        { headers: getHeaders(), timeout: 5000 }
      );
      return response.data || [];
    } catch (err) {
      return [];
    }
  },

  // שליפת שיחות אחרונות מהימים האחרונים (כולל אתמול וימים קודמים)
  async getRecentConversations(phone, days = 14, limit = 40) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return [];
    try {
      const sinceIso = daysAgoIso(days);
      const response = await axios.get(
        `${SUPABASE_URL}/conversation_logs?phone=eq.${encodeURIComponent(phone)}&created_at=gte.${encodeURIComponent(sinceIso)}&order=id.desc&limit=${limit}`,
        { headers: getHeaders(), timeout: 6000 }
      );
      return Array.isArray(response.data) ? response.data.reverse() : [];
    } catch (err) {
      console.warn("⚠️ [Supabase getRecentConversations]", err.message || err);
      return [];
    }
  },

  // חיפוש שיחות עבר לפי מילות נושא
  async searchConversationsByTopic(phone, topicKeywords = [], days = 14, limit = 5) {
    const rows = await this.getRecentConversations(phone, days, 60);
    if (!rows.length) return [];

    const cleanedKeywords = (topicKeywords || [])
      .map((k) => String(k || "").trim().toLowerCase())
      .filter((k) => k.length >= 2);

    if (!cleanedKeywords.length) {
      return rows.slice(-limit);
    }

    const scored = rows
      .map((row) => {
        const textPool = `${row.question || ""} ${row.answer || ""}`.toLowerCase();
        let score = 0;
        for (const kw of cleanedKeywords) {
          if (textPool.includes(kw)) score += 1;
        }
        return { row, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.row.id || 0) - (a.row.id || 0);
      });

    return scored.slice(0, limit).map((item) => item.row);
  },

  async getAllSystemConversationsForToday() {
    if (!SUPABASE_URL || !SUPABASE_KEY) return [];
    try {
      const response = await axios.get(`${SUPABASE_URL}/conversation_logs?order=id.desc&limit=10`, {
        headers: getHeaders(),
        timeout: 5000
      });
      return response.data || [];
    } catch (err) {
      return [];
    }
  },

  async getConversationsByLast4Digits(last4) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !last4) return [];
    try {
      const response = await axios.get(`${SUPABASE_URL}/conversation_logs?order=id.desc&limit=50`, {
        headers: getHeaders(),
        timeout: 5000
      });
      const allLogs = response.data || [];
      return allLogs.filter((item) => item.phone && String(item.phone).endsWith(last4)).slice(0, 3);
    } catch (err) {
      return [];
    }
  },

  async getLatestUserNameForToday(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return null;
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const response = await axios.get(
        `${SUPABASE_URL}/conversation_logs?phone=eq.${encodeURIComponent(phone)}&created_at=gte.${encodeURIComponent(todayStart.toISOString())}&user_name=not.is.null&order=id.desc&limit=1`,
        { headers: getHeaders(), timeout: 5000 }
      );
      return response.data && response.data.length > 0 ? response.data[0].user_name : null;
    } catch (err) {
      return null;
    }
  },

  async getLatestUserCityForToday(phone) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !phone) return null;
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const response = await axios.get(
        `${SUPABASE_URL}/conversation_logs?phone=eq.${encodeURIComponent(phone)}&created_at=gte.${encodeURIComponent(todayStart.toISOString())}&user_city=not.is.null&order=id.desc&limit=1`,
        { headers: getHeaders(), timeout: 5000 }
      );
      return response.data && response.data.length > 0 ? response.data[0].user_city : null;
    } catch (err) {
      return null;
    }
  }
};

module.exports = supabase;
