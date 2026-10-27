const express = require("express");
const axios = "axios" in globalThis ? globalThis.axios : require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

const config = require("./config");
const prompts = require("./prompts");
const supabase = require("./supabase");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

const bannedPhones = new Set();
const processedCalls = new Map();
const conversationHistory = new Map();
const requestLimits = new Map();

const checkRateLimit = (phone) => {
  if (!phone || phone === "default_user") return true;
  const now = Date.now();
  const userLog = requestLimits.get(phone) || [];
  const recentRequests = userLog.filter(timestamp => now - timestamp < 60000);
  if (recentRequests.length >= 10) return false;
  recentRequests.push(now);
  requestLimits.set(phone, recentRequests);
  return true;
};

const blockUserPermanently = (phone) => {
  bannedPhones.add(phone);
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

function sendYemotTtsResponse(res, text, nextFolder = "1") {
  const clean = (text || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[,.?!:;'"״׳`_\-*~#–—&?=<>/()\\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  res.set("Content-Type", "text/plain; charset=utf-8");
  return res.send(`id_list_message=t-${clean}&go_to_folder=/${nextFolder}`);
}

const callGeminiSimple = async (model, payload, geminiApiKey) => {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
  return axios.post(geminiUrl, payload, { headers: { "Content-Type": "application/json" }, timeout: 12000 });
};

async function downloadAndUploadToYemot(targetInput, token, targetFolder = "3") {
  const tempFilePath = path.join(__dirname, `temp_song_${Date.now()}.mp3`);
  try {
    let videoUrl = targetInput;
    if (!targetInput.startsWith("http://") && !targetInput.startsWith("https://")) {
      videoUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(targetInput)}`;
    } else {
      const match = targetInput.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
      if (match && match[1]) videoUrl = `https://www.youtube.com/watch?v=${match[1]}`;
    }

    const response = await axios.post("https://api.cobalt.tools/", { url: videoUrl, audioFormat: "mp3", isAudioOnly: true }, {
      headers: { "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      timeout: 25000
    });

    const downloadDirectUrl = response.data?.url || response.data?.stream;
    if (!downloadDirectUrl) throw new Error("קישור הורדה שגוי");

    const audioFileRes = await axios.get(downloadDirectUrl, { responseType: "stream", timeout: 30000 });
    const writer = fs.createWriteStream(tempFilePath);
    audioFileRes.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    const form = new FormData();
    form.append("file", fs.createReadStream(tempFilePath));
    const uploadUrl = `https://www.call2all.co.il/ym/api/UploadFile?token=${token}&path=ivr2:/${targetFolder}/000.mp3`;

    await axios.post(uploadUrl, form, { headers: form.getHeaders(), timeout: 30000 });
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    return true;
  } catch (err) {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    return false;
  }
}

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const token = params.token || params.TOKEN || params.ApiToken || params.SessionToken || process.env.YM_API_TOKEN;
    const userPhone = params.ApiPhone || params.phone || "default_user";

    if (!token) return sendYemotTtsResponse(res, "שגיאת אימות טוקן חסר");
    if (!checkRateLimit(userPhone)) return sendYemotTtsResponse(res, "חרגת ממספר הפניות המותר");

    const callId = params.ApiCallId || params.ApiYFCallId;
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";
    const requestedModel = params.MODEL || params.model;

    if (callId && processedCalls.has(callId)) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`go_to_folder=/1`);
    }
    if (callId) {
      processedCalls.set(callId, Date.now());
      setTimeout(() => processedCalls.delete(callId), 10000);
    }

    if (bannedPhones.has(userPhone)) return sendYemotTtsResponse(res, config.bannedUserResponse);

    let userSession = conversationHistory.get(userPhone) || { 
      history: [], timer: null, lastActive: Date.now(), blockedAttempts: 0, language: "he", persona: "רוני", checkedSupabaseToday: false, userName: null, userCity: null 
    };

    const parsedGeminiKeys = new Set([process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_1].filter(Boolean));
    const parsedOpenAIKeys = new Set([process.env.OPENAI_API_KEY, process.env.OPENAI_API_KEY_1].filter(Boolean));
    const parsedOpenRouterKeys = new Set([process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_1].filter(Boolean));
    let parsedDeepgram = process.env.DEEPGRAM_API_KEY || "";

    const directGemini = params.GEMINI_API_KEY || params.gemini_key || params.GeminiKey || params.AI_KEY || params.API || params.Api || params.api || params.KEY || params.Key || params.key || params.GEMINI;
    if (directGemini) parsedGeminiKeys.add(String(directGemini).trim());

    const directOpenAI = params.OPENAI || params.openai || params.OPENAI_API_KEY || params.openai_key || params.OpenAIKey;
    if (directOpenAI) parsedOpenAIKeys.add(String(directOpenAI).trim());

    const directOpenRouter = params.OPENROUTER || params.openrouter || params.OPENROUTER_API_KEY || params.openrouter_key || params.OpenRouterKey;
    if (directOpenRouter) parsedOpenRouterKeys.add(String(directOpenRouter).trim());

    const directDeepgram = params.DEEPGRAM || params.deepgram || params.DEEPGRAM_API_KEY || params.deepgram_key || params.DeepgramKey;
    if (directDeepgram) parsedDeepgram = String(directDeepgram).trim();

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

    let audioBuffer = null;
    const possiblePaths = [params.path, params.Path, params.file, params.File, params.ApiPath, `ivr2:/${secondaryFolder}/last.wav`, `ivr2:/${primaryFolder}/last.wav`].filter(Boolean);

    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;
      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 8000 });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          break;
        }
      } catch (err) {}
    }

    if (!audioBuffer) return sendYemotTtsResponse(res, "לא נמצאה הקלטה תקינה אנא הקלט שוב");

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
      return sendYemotTtsResponse(res, userSession.language === "en" ? "Please speak clearly" : "אנא דבר יותר לאט וברור");
    }

    const normalizedTranscription = normalizeText(transcribedText);

    if (config.switchToEnglishTriggers.some(t => normalizedTranscription.includes(t))) {
      userSession.language = "en";
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, "Switched to English. How can I help you?");
    }

    if (config.switchToHebrewTriggers.some(t => normalizedTranscription.includes(t))) {
      userSession.language = "he";
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, "עברנו חזרה לעברית במה אוכל לעזור");
    }

    if (config.personaTriggers.some(t => normalizedTranscription.includes(t))) {
      userSession.persona = transcribedText;
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, `הבנתי מעכשיו ${transcribedText} אבל ממשיך לשמור על הכללים`);
    }

    // זיהוי הגדרת שם
    if (config.nameTriggers.some(t => normalizedTranscription.includes(t))) {
      let extractedName = transcribedText;
      for (const t of config.nameTriggers) {
        extractedName = extractedName.replace(new RegExp(t, "i"), "").trim();
      }
      if (extractedName) {
        userSession.userName = extractedName;
        conversationHistory.set(userPhone, userSession);
        supabase.logConversation(userPhone, transcribedText, `נעים מאוד ${extractedName}`, "system-name", extractedName, userSession.userCity).catch(() => {});
        return sendYemotTtsResponse(res, `נעים מאוד ${extractedName} מעכשיו אזכור אותך במה אוכל לעזור`);
      }
    }

    // זיהוי הגדרת עיר/מיקום (למשל: "אני ממודיעין עילית")
    if (config.cityTriggers.some(t => normalizedTranscription.includes(t))) {
      let extractedCity = transcribedText;
      for (const t of config.cityTriggers) {
        extractedCity = extractedCity.replace(new RegExp(t, "i"), "").trim();
      }
      if (extractedCity) {
        userSession.userCity = extractedCity;
        conversationHistory.set(userPhone, userSession);
        supabase.logConversation(userPhone, transcribedText, `רשמתי שאתה מ${extractedCity}`, "system-city", userSession.userName, extractedCity).catch(() => {});
        return sendYemotTtsResponse(res, `מעולה רשמתי שאתה מ${extractedCity} במה עוד אוכל לעזור`);
      }
    }

    if (config.blockedKeywords.some(keyword => normalizedTranscription.includes(keyword))) {
      userSession.blockedAttempts += 1;
      if (userSession.blockedAttempts >= 3) {
        blockUserPermanently(userPhone);
        return sendYemotTtsResponse(res, config.bannedUserResponse);
      }
      userSession.lastActive = Date.now();
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, config.getWarningMessage(userSession.blockedAttempts));
    }

    if (config.resetTriggers.some(t => normalizedTranscription.includes(t))) {
      conversationHistory.set(userPhone, { history: [], timer: null, lastActive: Date.now(), blockedAttempts: userSession.blockedAttempts, language: "he", persona: "רוני", checkedSupabaseToday: true, userName: userSession.userName, userCity: userSession.userCity });
      return sendYemotTtsResponse(res, "השיחה אופסה בהצלחה שמי רוני במה אוכל לעזור");
    }

    // טעינת שם ועיר מ-Supabase אם טרם נטענו
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

    if (!finalAnswerText) finalAnswerText = "הגעת למכסה היומית אנא נסה שוב מאוחר יותר";

    // שמירת השיחה ל-Supabase ברקע (כולל שם ועיר)
    supabase.logConversation(userPhone, transcribedText, finalAnswerText, usedModelName, userSession.userName, userSession.userCity).catch(() => {});

    if (finalAnswerText.includes("PLAY_SONG:")) {
      const songTarget = finalAnswerText.split("PLAY_SONG:")[1].trim();
      const success = await downloadAndUploadToYemot(songTarget, token, "3");
      return success ? sendYemotTtsResponse(res, "השיר מוכן מעביר אותך לשלוחת השירים", "3") : sendYemotTtsResponse(res, "מצטער לא הצלחתי להוריד את השיר");
    }

    if (normalizeText(finalAnswerText).includes(config.blockedResponseMarker)) {
      userSession.blockedAttempts += 1;
      if (userSession.blockedAttempts >= 3) {
        blockUserPermanently(userPhone);
        return sendYemotTtsResponse(res, config.bannedUserResponse);
      }
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, config.getWarningMessage(userSession.blockedAttempts));
    }

    userSession.history.push({ role: "user", content: transcribedText });
    userSession.history.push({ role: "assistant", content: finalAnswerText });
    if (userSession.history.length > 6) userSession.history = userSession.history.slice(-6);
    conversationHistory.set(userPhone, userSession);

    return sendYemotTtsResponse(res, finalAnswerText);
  } catch (error) {
    return sendYemotTtsResponse(res, "חלה שגיאה במערכת אנא נסה שנית");
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
