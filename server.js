// ==========================================
// 🚀 קובץ השרת הראשי המלא (כולל המרת MP3 תואמת לימות המשיח + ElevenLabs)
// ==========================================

const express = require("express");
const axios = "axios" in globalThis ? globalThis.axios : require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const ffmpeg = require("fluent-ffmpeg");

const config = require("./config");
const prompts = require("./prompts");
const supabase = require("./supabase");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

const ADMIN_PHONE = "0556755846";
const processedCalls = new Map();
const conversationHistory = new Map();
const requestLimits = new Map();

const checkRateLimit = (phone) => {
  if (!phone || phone === "default_user" || phone === ADMIN_PHONE) return true;
  const now = Date.now();
  const userLog = requestLimits.get(phone) || [];
  const recentRequests = userLog.filter(timestamp => now - timestamp < 60000);
  if (recentRequests.length >= 10) return false;
  recentRequests.push(now);
  requestLimits.set(phone, recentRequests);
  return true;
};

// חסימת משתמש קבועה במסד הנתונים
const blockUserPermanently = async (phone) => {
  if (phone === ADMIN_PHONE) return;
  await supabase.banUser(phone, "חריגה מוגזמת מכללי השימוש");
  
  if (conversationHistory.has(phone)) {
    const session = conversationHistory.get(phone);
    if (session.timer) clearTimeout(session.timer);
    conversationHistory.delete(phone);
  }
};

setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of conversationHistory.entries()) {
    if (session.lastActive && now - session.lastActive > 10 * 60 * 1000) {
      if (session.timer) clearTimeout(session.timer);
      conversationHistory.delete(phone);
    }
  }
}, 60 * 60 * 1000);

const normalizeText = (text) => {
  if (!text) return "";
  return text
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[,.?!:;'"״׳`_\-*~#–—&?=<>/()\\[\]{}]/g, " ")
    .replace(/ם/g, "מ")
    .replace(/ן/g, "נ")
    .replace(/ץ/g, "צ")
    .replace(/ף/g, "פ")
    .replace(/ך/g, "כ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
};

// פונקציית גיבוי להקראת טקסט של ימות המשיח (למקרה שאין הקלטה או שגיאה)
function sendYemotTtsResponse(res, text, returnFolder = "1") {
  const clean = (text || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[,.?!:;'"״׳`_\-*~#–—&?=<>/()\\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  res.set("Content-Type", "text/plain; charset=utf-8");
  console.log(`🟡 [Response] שולח פקודת הקראת טקסט לימות המשיח (גיבוי): t-${clean}`);
  return res.send(`id_list_message=t-${clean}&go_to_folder=/${returnFolder}`);
}

// 🟢 השמעת קובץ WAV משלוחה אחרת באמצעות תחביר l- של id_list_message
function sendYemotFileResponse(res, folderNumber = "1", fileName = "000", returnFolder = "1") {
  res.set("Content-Type", "text/plain; charset=utf-8");

  // לפי תחביר ימות: l-/נתיב-השלוחה.f-שם-הקובץ
  // ימות משמיעה את קובץ ה-WAV לפי שם הקובץ ללא הסיומת.
  const command = `id_list_message=l-/${folderNumber}.f-${fileName}&go_to_folder=/${returnFolder}`;

  console.log(`🟢 [Response] שולח פקודת השמעת WAV לימות המשיח: ${command}`);
  return res.send(command);
}

// המרה אחידה ל-WAV טלפוני: PCM signed 16-bit, mono, 8000Hz
function convertToYemotWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath)
      .noVideo()
      .audioCodec("pcm_s16le")
      .audioChannels(1)
      .audioFrequency(8000)
      .format("wav")
      .on("end", resolve)
      .on("error", reject);

    command.save(outputPath);
  });
}

// פונקציה להמרת טקסט לדיבור דרך ElevenLabs, המרה ל-WAV והעלאה לשלוחה 1 דרך ElevenLabs, המרה תקנית עם FFmpeg, והעלאה לשלוחה 1
async function generateAndUploadElevenLabsTts(text, token, elevenLabsApiKey, targetFolder = "1") {
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const rawFilePath = path.join(__dirname, `temp_raw_${uniqueId}.mp3`);
  const convertedFilePath = path.join(__dirname, `temp_converted_${uniqueId}.wav`);
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";

  console.log(`🎙️ [TTS] מתחיל ייצור שמע ב-ElevenLabs, אורך טקסט: ${String(text || "").length} תווים...`);

  try {
    const ttsRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_22050_32`,
      {
        text: String(text || ""),
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.75,
          similarity_boost: 0.85
        }
      },
      {
        headers: {
          "xi-api-key": elevenLabsApiKey,
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer",
        timeout: 30000
      }
    );

    if (!ttsRes.data || !Buffer.from(ttsRes.data).length) {
      throw new Error("ElevenLabs returned an empty audio file");
    }

    fs.writeFileSync(rawFilePath, Buffer.from(ttsRes.data));
    console.log("✅ [TTS] התקבל MP3. ממיר ל-WAV טלפוני PCM 16-bit, mono, 8000Hz...");

    await convertToYemotWav(rawFilePath, convertedFilePath);

    const stat = fs.statSync(convertedFilePath);
    if (!stat.size || stat.size < 44) {
      throw new Error(`Converted WAV is empty or invalid (${stat.size} bytes)`);
    }

    console.log(`📤 [Yemot] מעלה WAV לשלוחה ${targetFolder} (000.wav), גודל: ${stat.size} bytes`);

    const form = new FormData();
    form.append("file", fs.createReadStream(convertedFilePath), {
      filename: "000.wav",
      contentType: "audio/wav"
    });

    const uploadPath = `ivr2:/${targetFolder}/000.wav`;
    const uploadUrl = `https://www.call2all.co.il/ym/api/UploadFile?${new URLSearchParams({
      token: String(token),
      path: uploadPath
    }).toString()}`;

    const uploadRes = await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      timeout: 30000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    console.log("📥 [Yemot] תגובת העלאה:", uploadRes.data);

    if (uploadRes.data?.messageCode) {
      throw new Error(`Yemot upload error ${uploadRes.data.messageCode}: ${uploadRes.data.message || "unknown error"}`);
    }

    // לפי תיעוד UploadFile, הצלחה מחזירה path ו-size.
    if (!uploadRes.data || (!uploadRes.data.path && !uploadRes.data.size)) {
      throw new Error(`Yemot did not confirm the uploaded file: ${JSON.stringify(uploadRes.data)}`);
    }

    console.log(`✅ [Yemot] קובץ WAV הועלה בהצלחה: ${uploadRes.data.path || uploadPath}`);

    return true;
  } catch (err) {
    console.error("❌ [TTS] שגיאה ביצירה / המרה / העלאה:", err.response?.data || err.message || err);
    return false;
  } finally {
    for (const filePath of [rawFilePath, convertedFilePath]) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (cleanupError) {
        console.warn("⚠️ [TTS] לא הצלחתי למחוק קובץ זמני:", cleanupError.message);
      }
    }
  }
}

const callGeminiSimple = async (model, payload, geminiApiKey) => {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
  return axios.post(geminiUrl, payload, { headers: { "Content-Type": "application/json" }, timeout: 12000 });
};

async function downloadAndUploadToYemot(targetInput, token, targetFolder = "1") {
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tempMp3Path = path.join(__dirname, `temp_song_${uniqueId}.mp3`);
  const tempWavPath = path.join(__dirname, `temp_song_${uniqueId}.wav`);

  try {
    let videoUrl = targetInput;

    if (!targetInput.startsWith("http://") && !targetInput.startsWith("https://")) {
      videoUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(targetInput)}`;
    } else {
      const match = targetInput.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
      if (match && match[1]) videoUrl = `https://www.youtube.com/watch?v=${match[1]}`;
    }

    const response = await axios.post(
      "https://api.cobalt.tools/",
      { url: videoUrl, audioFormat: "mp3", isAudioOnly: true },
      {
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        timeout: 30000
      }
    );

    const downloadDirectUrl = response.data?.url || response.data?.stream;
    if (!downloadDirectUrl) throw new Error("קישור הורדה שגוי");

    const audioFileRes = await axios.get(downloadDirectUrl, {
      responseType: "stream",
      timeout: 45000
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(tempMp3Path);
      audioFileRes.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
      audioFileRes.data.on("error", reject);
    });

    if (!fs.existsSync(tempMp3Path) || fs.statSync(tempMp3Path).size === 0) {
      throw new Error("קובץ השיר שהורד ריק");
    }

    console.log("🎵 [Song] ממיר את השיר ל-WAV טלפוני...");
    await convertToYemotWav(tempMp3Path, tempWavPath);

    const wavSize = fs.statSync(tempWavPath).size;
    if (wavSize < 44) throw new Error("המרת השיר ל-WAV נכשלה או יצרה קובץ ריק");

    const form = new FormData();
    form.append("file", fs.createReadStream(tempWavPath), {
      filename: "000.wav",
      contentType: "audio/wav"
    });

    const uploadPath = `ivr2:/${targetFolder}/000.wav`;
    const uploadUrl = `https://www.call2all.co.il/ym/api/UploadFile?${new URLSearchParams({
      token: String(token),
      path: uploadPath
    }).toString()}`;

    const uploadRes = await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      timeout: 45000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    console.log("📥 [Yemot] תגובת העלאת השיר:", uploadRes.data);

    if (uploadRes.data?.messageCode) {
      throw new Error(`Yemot upload error ${uploadRes.data.messageCode}: ${uploadRes.data.message || "unknown error"}`);
    }

    if (!uploadRes.data || (!uploadRes.data.path && !uploadRes.data.size)) {
      throw new Error(`Yemot did not confirm the uploaded song: ${JSON.stringify(uploadRes.data)}`);
    }

    console.log(`✅ [Song] השיר הועלה כ-WAV: ${uploadRes.data.path || uploadPath}`);
    return true;
  } catch (err) {
    console.error("❌ [Song] שגיאה בהורדה / המרה / העלאה:", err.response?.data || err.message || err);
    return false;
  } finally {
    for (const filePath of [tempMp3Path, tempWavPath]) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (cleanupError) {
        console.warn("⚠️ [Song] לא הצלחתי למחוק קובץ זמני:", cleanupError.message);
      }
    }
  }
}

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const token = params.token || params.TOKEN || params.ApiToken || params.SessionToken || process.env.YM_API_TOKEN;
    const userPhone = params.ApiPhone || params.phone || "default_user";
    const isAdminUser = (userPhone === ADMIN_PHONE);

    const targetReturnFolder = "1";

    if (!token) return sendYemotTtsResponse(res, "שגיאת אימות טוקן חסר", targetReturnFolder);
    if (!checkRateLimit(userPhone)) return sendYemotTtsResponse(res, "חרגת ממספר הפניות המותר", targetReturnFolder);

    const isBanned = !isAdminUser && await supabase.isUserBanned(userPhone);
    if (isBanned) {
      return sendYemotTtsResponse(res, config.bannedUserResponse, targetReturnFolder);
    }

    const callId = params.ApiCallId || params.ApiYFCallId;
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";
    const requestedModel = params.MODEL || params.model;

    if (callId && processedCalls.has(callId)) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`go_to_folder=/${targetReturnFolder}`);
    }
    if (callId) {
      processedCalls.set(callId, Date.now());
      setTimeout(() => processedCalls.delete(callId), 10000);
    }

    let userSession = conversationHistory.get(userPhone) || { 
      history: [], timer: null, lastActive: Date.now(), blockedAttempts: 0, language: "he", persona: "רוני", checkedSupabaseToday: false, userName: null, userCity: null, isAdminAuthenticated: false, awaitingAdminPassword: false 
    };

    const parsedGeminiKeys = new Set([process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_1].filter(Boolean));
    const parsedOpenAIKeys = new Set([process.env.OPENAI_API_KEY, process.env.OPENAI_API_KEY_1].filter(Boolean));
    const parsedOpenRouterKeys = new Set([process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_1].filter(Boolean));
    let parsedDeepgram = process.env.DEEPGRAM_API_KEY || "";
    let parsedElevenLabs = process.env.ELEVENLABS_API_KEY || "";

    const directGemini = params.GEMINI_API_KEY || params.gemini_key || params.GeminiKey || params.AI_KEY || params.API || params.Api || params.api || params.KEY || params.Key || params.key || params.GEMINI;
    if (directGemini) parsedGeminiKeys.add(String(directGemini).trim());

    const directOpenAI = params.OPENAI || params.openai || params.OPENAI_API_KEY || params.openai_key || params.OpenAIKey;
    if (directOpenAI) parsedOpenAIKeys.add(String(directOpenAI).trim());

    const directOpenRouter = params.OPENROUTER || params.openrouter || params.OPENROUTER_API_KEY || params.openrouter_key || params.OpenRouterKey;
    if (directOpenRouter) parsedOpenRouterKeys.add(String(directOpenRouter).trim());

    const directDeepgram = params.DEEPGRAM || params.deepgram || params.DEEPGRAM_API_KEY || params.deepgram_key || params.DeepgramKey;
    if (directDeepgram) parsedDeepgram = String(directDeepgram).trim();

    const directElevenLabs = params.ELEVENLABS || params.elevenlabs || params.ELEVENLABS_API_KEY || params.elevenlabs_key || params.ElevenLabsKey;
    if (directElevenLabs) parsedElevenLabs = String(directElevenLabs).trim();

    const extractKeysDeeply = (obj, depth = 0) => {
      if (depth > 5 || !obj) return;
      for (const value of Object.values(obj)) {
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) {
          if (typeof item === "string") {
            const parts = item.split(/[\s,;|]+/).map(p => p.trim()).filter(Boolean);
            for (const part of parts) {
              if (part.startsWith("AIza") || part.startsWith("AQ.")) parsedGeminiKeys.add(part);
              else if (part.startsWith("sk-proj-") || (part.startsWith("sk-") && !part.startsWith("sk-or-"))) parsedOpenAIKeys.add(part);
              else if (part.startsWith("sk-or-")) parsedOpenRouterKeys.add(part);
              else if (part.startsWith("xi-")) parsedElevenLabs = part;
              else if (part.length === 40 && /^[a-f0-9]{40}$/i.test(part)) parsedDeepgram = part;
            }
          } else if (typeof item === "object" && item !== null) extractKeysDeeply(item, depth + 1);
        }
      }
    };
    extractKeysDeeply(params);

    const geminiKeys = Array.from(parsedGeminiKeys);
    const openAIKeys = Array.from(parsedOpenAIKeys);
    const openRouterKeys = Array.from(parsedOpenRouterKeys);
    const deepgramApiKey = parsedDeepgram.trim();
    const elevenLabsApiKey = parsedElevenLabs.trim();

    let audioBuffer = null;
    // 🔍 סדר חיפוש ההקלטה המדורג: שלוחה 1 -> שלוחה 2 -> שלוחה 3 ואז שאר האפשרויות
    const possiblePaths = [
      `ivr2:/1/last.wav`, 
      `ivr2:/2/last.wav`, 
      `ivr2:/3/last.wav`, 
      params.path, 
      params.Path, 
      params.file, 
      params.File, 
      params.ApiPath, 
      `ivr2:/${secondaryFolder}/last.wav`, 
      `ivr2:/${primaryFolder}/last.wav`
    ].filter(Boolean);

    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;
      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 8000 });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          console.log(`📁 [Audio] נמצא קובץ הקלטה תקין בנתיב: ${cleanPath}`);
          break;
        }
      } catch (err) {}
    }

    if (!audioBuffer) return sendYemotTtsResponse(res, "לא נמצאה הקלטה תקינה אנא הקלט שוב", targetReturnFolder);

    let transcribedText = "";
    if (deepgramApiKey) {
      try {
        const dgResponse = await axios.post(`https://api.deepgram.com/v1/listen?language=${userSession.language}&model=nova-3&smart_format=true`, audioBuffer, {
          headers: { "Authorization": `Token ${deepgramApiKey}`, "Content-Type": "audio/wav" },
          timeout: 10000
        });
        transcribedText = (dgResponse.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
      } catch (err) {}
    }

    if (!transcribedText || transcribedText.length < 1) {
      return sendYemotTtsResponse(res, userSession.language === "en" ? "Please speak clearly" : "אנא דבר יותר לאט וברור", targetReturnFolder);
    }

    const normalizedTranscription = normalizeText(transcribedText);

    // ==========================================
    // 👑 ניהול מצב מנהל
    // ==========================================

    if (userSession.isAdminAuthenticated && config.adminLogoutTriggers.some(t => normalizedTranscription.includes(t))) {
      userSession.isAdminAuthenticated = false;
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, "יצאת ממצב מנהל בהצלחה במה עוד אוכל לעזור", targetReturnFolder);
    }

    if (!userSession.isAdminAuthenticated && !userSession.awaitingAdminPassword && config.adminLoginTriggers.some(t => normalizedTranscription.includes(t))) {
      userSession.awaitingAdminPassword = true;
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, "נא הקלד את סיסמת הניהול", targetReturnFolder);
    }

    if (userSession.awaitingAdminPassword) {
      userSession.awaitingAdminPassword = false;
      
      let enteredPassword = transcribedText.replace(/\s+/g, "").trim();
      const wordToNum = { "אחת": "1", "שתיים": "2", "שלוש": "3", "ארבע": "4", "חמש": "5", "שש": "6", "שבע": "7", "שמונה": "8", "תשע": "9", "אפס": "0" };
      for (const [word, num] of Object.entries(wordToNum)) {
        if (transcribedText.includes(word)) {
          enteredPassword = enteredPassword.replace(new RegExp(word, "g"), num);
        }
      }
      enteredPassword = enteredPassword.replace(/\D/g, "");

      if (enteredPassword === config.adminPassword) {
        userSession.isAdminAuthenticated = true;
        conversationHistory.set(userPhone, userSession);
        return sendYemotTtsResponse(res, "סיסמה נכונה ברוך הבא למצב מנהל איזה מידע תרצה לשלוף", targetReturnFolder);
      } else {
        conversationHistory.set(userPhone, userSession);
        return sendYemotTtsResponse(res, "סיסמה שגויה חזרת למצב רגיל", targetReturnFolder);
      }
    }

    if (userSession.isAdminAuthenticated) {
      if (normalizedTranscription.includes("חסום") || normalizedTranscription.includes("תחסום")) {
        const phoneMatch = transcribedText.match(/0[2-9]\d{8,9}|05\d{8}/);
        const targetPhone = phoneMatch ? phoneMatch[0] : null;
        if (targetPhone) {
          if (targetPhone === ADMIN_PHONE) {
            return sendYemotTtsResponse(res, "לא ניתן לחסום את מספר המנהל הראשי", targetReturnFolder);
          }
          await supabase.banUser(targetPhone, "חסימה ידנית על ידי מנהל");
          return sendYemotTtsResponse(res, `המספר ${targetPhone} נחסם בהצלחה מהמערכת`, targetReturnFolder);
        } else {
          return sendYemotTtsResponse(res, "לא זיהיתי מספר טלפון תקין לחסימה אנא אמור שוב", targetReturnFolder);
        }
      }

      if (normalizedTranscription.includes("שחרר") || normalizedTranscription.includes("בטל חסימה") || normalizedTranscription.includes("הסר חסימה")) {
        const phoneMatch = transcribedText.match(/0[2-9]\d{8,9}|05\d{8}/);
        const targetPhone = phoneMatch ? phoneMatch[0] : null;
        if (targetPhone) {
          await supabase.unbanUser(targetPhone);
          return sendYemotTtsResponse(res, `החסימה עבור המספר ${targetPhone} בוטלה בהצלחה`, targetReturnFolder);
        } else {
          return sendYemotTtsResponse(res, "לא זיהיתי מספר טלפון תקין לביטול חסימה", targetReturnFolder);
        }
      }

      if (normalizedTranscription.includes("לוגים") || normalizedTranscription.includes("פעילות") || normalizedTranscription.includes("לוג")) {
        try {
          const recentLogs = await supabase.getAllSystemConversationsForToday();
          if (recentLogs && recentLogs.length > 0) {
            let logText = "הפעילויות האחרונות במערכת . ";
            recentLogs.slice(0, 3).forEach((item) => {
              logText += `משתמש ${item.phone} שאל: ${item.question} וענה לו: ${item.answer} . `;
            });
            return sendYemotTtsResponse(res, logText, targetReturnFolder);
          } else {
            return sendYemotTtsResponse(res, "אין פעילות רשומה במערכת", targetReturnFolder);
          }
        } catch (err) {
          return sendYemotTtsResponse(res, "שגיאה בשליפת הלוגים האחרונים", targetReturnFolder);
        }
      }

      let digitsOnly = transcribedText.replace(/\D/g, "");
      const wordToNumMap = { "אפס": "0", "אחת": "1", "שתיים": "2", "שלוש": "3", "ארבע": "4", "חמש": "5", "שש": "6", "שבע": "7", "שמונה": "8", "תשע": "9" };
      if (digitsOnly.length === 0) {
        for (const [word, num] of Object.entries(wordToNumMap)) {
          if (transcribedText.includes(word)) digitsOnly += num;
        }
      }

      const isOnlyFourDigits = /^\d{4}$/.test(digitsOnly) || transcribedText.replace(/\D/g, "").length === 4;

      if (normalizedTranscription.includes("שאלות") || normalizedTranscription.includes("תשובות") || normalizedTranscription.includes("היסטוריה") || normalizedTranscription.includes("שיחות") || isOnlyFourDigits) {
        const fullPhoneMatch = transcribedText.match(/0[2-9]\d{8,9}|05\d{8}/);
        const fourDigitsMatch = isOnlyFourDigits ? [transcribedText.replace(/\D/g, "").slice(-4)] : transcribedText.match(/\b\d{4}\b/);

        if (fullPhoneMatch) {
          const targetPhone = fullPhoneMatch[0];
          try {
            const allLogs = await supabase.getAllConversationsForToday(targetPhone);
            if (allLogs && allLogs.length > 0) {
              const lastConvs = allLogs.slice(-3);
              let responseText = `נמצאו שיחות עבור המספר ${targetPhone} . `;
              lastConvs.forEach((item, index) => {
                responseText += `שיחה ${index + 1} . שאלה: ${item.question || "ללא"} . תשובה: ${item.answer || "ללא"} . `;
              });
              return sendYemotTtsResponse(res, responseText, targetReturnFolder);
            } else {
              return sendYemotTtsResponse(res, `לא נמצאו שיחות עבור המספר ${targetPhone}`, targetReturnFolder);
            }
          } catch (err) {
            return sendYemotTtsResponse(res, "שגיאה בשליפת הנתונים ממסד הנתונים", targetReturnFolder);
          }
        } else if (fourDigitsMatch || digitsOnly.length >= 4) {
          const last4 = fourDigitsMatch ? fourDigitsMatch[0] : digitsOnly.slice(-4);
          try {
            const matchedLogs = await supabase.getConversationsByLast4Digits(last4);
            if (matchedLogs && matchedLogs.length > 0) {
              const lastConvs = matchedLogs.slice(0, 3);
              let responseText = `נמצאו שיחות עבור מספר המסתיים ב ${last4} . `;
              lastConvs.forEach((item, index) => {
                responseText += `שיחה ${index + 1} של משתמש ${item.phone} . שאלה: ${item.question || "ללא"} . תשובה: ${item.answer || "ללא"} . `;
              });
              return sendYemotTtsResponse(res, responseText, targetReturnFolder);
            } else {
              return sendYemotTtsResponse(res, `לא נמצאו שיחות עבור מספר המסתיים ב ${last4}`, targetReturnFolder);
            }
          } catch (err) {
            return sendYemotTtsResponse(res, "שגיאה בשליפת הנתונים לפי 4 ספרות", targetReturnFolder);
          }
        } else {
          return sendYemotTtsResponse(res, "לא זיהיתי מספר טלפון או ארבע ספרות אנא אמור שוב", targetReturnFolder);
        }
      }
    }

    // ==========================================
    // 🤖 המשך זרימה רגילה
    // ==========================================

    if (config.switchToEnglishTriggers.some(t => normalizedTranscription.includes(t))) {
      userSession.language = "en";
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, "Switched to English. How can I help you?", targetReturnFolder);
    }

    if (config.switchToHebrewTriggers.some(t => normalizedTranscription.includes(t))) {
      userSession.language = "he";
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, "עברנו חזרה לעברית במה אוכל לעזור", targetReturnFolder);
    }

    if (config.personaTriggers.some(t => normalizedTranscription.includes(t))) {
      userSession.persona = transcribedText;
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, `הבנתי מעכשיו ${transcribedText} אבל ממשיך לשמור על הכללים`, targetReturnFolder);
    }

    if (!userSession.checkedSupabaseToday) {
      userSession.checkedSupabaseToday = true;
      try {
        const [savedName, savedCity] = await Promise.all([
          supabase.getLatestUserNameForToday(userPhone),
          supabase.getLatestUserCityForToday(userPhone)
        ]);
        if (savedName) userSession.userName = savedName;
        if (savedCity) userSession.userCity = savedCity;
      } catch (err) {}
    }

    if (config.nameTriggers.some(t => normalizedTranscription.includes(t))) {
      const wantsToChangeName = config.changeNameTriggers.some(cnt => normalizedTranscription.includes(cnt));
      if (!userSession.userName || wantsToChangeName) {
        let extractedName = transcribedText;
        for (const cnt of config.changeNameTriggers) {
          extractedName = extractedName.replace(new RegExp(cnt, "i"), "").trim();
        }
        for (const t of config.nameTriggers) {
          extractedName = extractedName.replace(new RegExp(t, "i"), "").trim();
        }
        if (extractedName) {
          userSession.userName = extractedName;
          conversationHistory.set(userPhone, userSession);
          supabase.logConversation(userPhone, transcribedText, `נעים מאוד ${extractedName}`, "system-name", extractedName, userSession.userCity).catch(() => {});
          return sendYemotTtsResponse(res, `נעים מאוד ${extractedName} מעכשיו אזכור אותך במה אוכל לעזור`, targetReturnFolder);
        }
      }
    }

    if (config.cityTriggers.some(t => normalizedTranscription.includes(t))) {
      const wantsToChangeCity = config.changeCityTriggers.some(ct => normalizedTranscription.includes(ct));
      if (!userSession.userCity || wantsToChangeCity) {
        let extractedCity = transcribedText;
        for (const ct of config.changeCityTriggers) {
          extractedCity = extractedCity.replace(new RegExp(ct, "i"), "").trim();
        }
        for (const t of config.cityTriggers) {
          extractedCity = extractedCity.replace(new RegExp(t, "i"), "").trim();
        }
        if (extractedCity) {
          userSession.userCity = extractedCity;
          conversationHistory.set(userPhone, userSession);
          supabase.logConversation(userPhone, transcribedText, `רשמתי שאתה מ${extractedCity}`, "system-city", userSession.userName, extractedCity).catch(() => {});
          return sendYemotTtsResponse(res, `מעולה רשמתי שאתה מ${extractedCity} במה עוד אוכל לעזור`, targetReturnFolder);
        }
      }
    }

    if (!isAdminUser && !userSession.isAdminAuthenticated && config.blockedKeywords.some(keyword => normalizedTranscription.includes(keyword))) {
      userSession.blockedAttempts += 1;
      if (userSession.blockedAttempts >= 3) {
        await blockUserPermanently(userPhone);
        return sendYemotTtsResponse(res, config.bannedUserResponse, targetReturnFolder);
      }
      userSession.lastActive = Date.now();
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, config.getWarningMessage(userSession.blockedAttempts), targetReturnFolder);
    }

    if (config.resetTriggers.some(t => normalizedTranscription.includes(t))) {
      conversationHistory.set(userPhone, { history: [], timer: null, lastActive: Date.now(), blockedAttempts: userSession.blockedAttempts, language: "he", persona: "רוני", checkedSupabaseToday: true, userName: userSession.userName, userCity: userSession.userCity, isAdminAuthenticated: false, awaitingAdminPassword: false });
      return sendYemotTtsResponse(res, "השיחה אופסה בהצלחה שמי רוני במה אוכל לעזור", targetReturnFolder);
    }

    const isSummaryRequested = config.summaryTriggers.some(t => normalizedTranscription.includes(t));
    let previousContext = null;

    if (isSummaryRequested) {
      try {
        const allLogs = await supabase.getAllConversationsForToday(userPhone);
        if (allLogs && allLogs.length > 0) {
          const formattedHistory = allLogs.map(l => `שאלה: "${l.question}" | תשובה: "${l.answer}"`).join("\n");
          previousContext = { isFullSummary: true, summaryText: formattedHistory };
        }
      } catch (err) {}
    } else {
      try {
        const lastConv = await supabase.getLatestConversationForToday(userPhone);
        if (lastConv) previousContext = lastConv;
      } catch (err) {}
    }

    const isDeepRequested = config.deepDetailsTriggers.some(t => normalizedTranscription.includes(t));

    if (userSession.timer) clearTimeout(userSession.timer);
    userSession.lastActive = Date.now();
    userSession.timer = setTimeout(() => conversationHistory.delete(userPhone), 10 * 60 * 1000);

    let finalAnswerText = "";
    let usedModelName = "unknown";
    const systemInstruction = prompts.getSystemInstruction(
      userSession.language, 
      userSession.persona, 
      isDeepRequested, 
      previousContext, 
      userSession.userName, 
      userSession.userCity,
      userSession.history.length
    );
    const needsSearch = config.searchKeywords.some(word => transcribedText.toLowerCase().includes(word));

    if (geminiKeys.length > 0) {
      const geminiModels = requestedModel ? [requestedModel, "gemini-2.5-flash-lite", "gemini-2.5-flash"] : ["gemini-2.5-flash-lite", "gemini-2.5-flash"];
      const geminiContents = [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "Understood." }] }
      ];
      userSession.history.forEach(m => geminiContents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      geminiContents.push({ role: "user", parts: [{ text: transcribedText }] });

      const payload = { contents: geminiContents };
      if (needsSearch) payload.tools = [{ googleSearch: {} }];

      for (let k = 0; k < geminiKeys.length; k++) {
        if (finalAnswerText) break;
        for (const model of geminiModels) {
          try {
            const response = await callGeminiSimple(model, payload, geminiKeys[k]);
            if (response?.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
              finalAnswerText = response.data.candidates[0].content.parts[0].text;
              usedModelName = `gemini (${model})`;
              break;
            }
          } catch (err) {}
        }
      }
    }

    if (!finalAnswerText && openAIKeys.length > 0) {
      for (const oaKey of openAIKeys) {
        if (finalAnswerText) break;
        try {
          const oaResponse = await axios.post("https://api.openai.com/v1/chat/completions", {
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: systemInstruction }, ...userSession.history, { role: "user", content: transcribedText }]
          }, { headers: { "Authorization": `Bearer ${oaKey}`, "Content-Type": "application/json" }, timeout: 12000 });
          if (oaResponse?.data?.choices?.[0]?.message?.content) {
            finalAnswerText = oaResponse.data.choices[0].message.content;
            usedModelName = "openai (gpt-4o-mini)";
            break;
          }
        } catch (e) {}
      }
    }

    if (!finalAnswerText && openRouterKeys.length > 0) {
      for (const orKey of openRouterKeys) {
        if (finalAnswerText) break;
        try {
          const orResponse = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            model: "openrouter/auto",
            messages: [{ role: "system", content: systemInstruction }, ...userSession.history, { role: "user", content: transcribedText }]
          }, { headers: { "Authorization": `Bearer ${orKey}`, "Content-Type": "application/json" }, timeout: 12000 });
          if (orResponse?.data?.choices?.[0]?.message?.content) {
            finalAnswerText = orResponse.data.choices[0].message.content;
            usedModelName = "openrouter (auto-free)";
            break;
          }
        } catch (e) {}
      }
    }

    if (!finalAnswerText) finalAnswerText = "אני לא יכול לענות כרגע הגעת למכסה היומית אנא נסה שוב מאוחר יותר";

    supabase.logConversation(userPhone, transcribedText, finalAnswerText, usedModelName, userSession.userName, userSession.userCity).catch(() => {});

    if (finalAnswerText.includes("PLAY_SONG:")) {
      const songTarget = finalAnswerText.split("PLAY_SONG:")[1].trim();
      const success = await downloadAndUploadToYemot(songTarget, token, "1");
      return success ? sendYemotFileResponse(res, "1", "000", targetReturnFolder) : sendYemotTtsResponse(res, "אני לא הצלחתי להוריד את השיר מצטער", targetReturnFolder);
    }

    if (!isAdminUser && !userSession.isAdminAuthenticated && normalizeText(finalAnswerText).includes(config.blockedResponseMarker)) {
      userSession.blockedAttempts += 1;
      if (userSession.blockedAttempts >= 3) {
        await blockUserPermanently(userPhone);
        return sendYemotTtsResponse(res, config.bannedUserResponse, targetReturnFolder);
      }
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, config.getWarningMessage(userSession.blockedAttempts), targetReturnFolder);
    }

    userSession.history.push({ role: "user", content: transcribedText });
    userSession.history.push({ role: "assistant", content: finalAnswerText });
    if (userSession.history.length > 6) userSession.history = userSession.history.slice(-6);
    conversationHistory.set(userPhone, userSession);

    // ==========================================
    // 🎙️ הפעלת ElevenLabs TTS והעלאה לשלוחה 1
    // ==========================================
    if (elevenLabsApiKey) {
      const ttsSuccess = await generateAndUploadElevenLabsTts(finalAnswerText, token, elevenLabsApiKey, "1");
      if (ttsSuccess) {
        return sendYemotFileResponse(res, "1", "000", targetReturnFolder);
      }
    }

    // גיבוי למקרה שאין ElevenLabs: חזרה ל-TTS של ימות בשלוחה 1
    return sendYemotTtsResponse(res, finalAnswerText, targetReturnFolder);

  } catch (error) {
    console.error("❌ [Server Error]:", error);
    return sendYemotTtsResponse(res, "אני מתנצל חלה שגיאה במערכת אנא נסה שנית", "1");
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
