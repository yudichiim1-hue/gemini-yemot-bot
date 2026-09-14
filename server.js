const express = require("express");
const axios = "axios" in globalThis ? globalThis.axios : require("axios");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

const processedCalls = new Map();

app.get("/ping", (req, res) => {
  res.status(200).send("PONG");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date() });
});

const formatTextForYemot = (text) => {
  if (!text) return "";
  return text
    .replace(/[^א-ת0-9\s]/g, "") // ניקוי מוחלט לטובת ימות המשיח
    .replace(/\s+/g, " ")
    .trim();
};

const handleAudioRequest = async (req, res) => {
  const startTime = Date.now();
  console.log("\n==================================================");
  console.log("🟢 [חג ושמח] התקבלה קריאה חדשה ממערכת ימות המשיח!");

  try {
    const params = { ...req.query, ...req.body };
    const callId = params.ApiCallId || params.ApiYFCallId;
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";

    console.log(`📞 [זיהוי שיחה] Call ID: ${callId || "לא נמצא"}, תיקיות: ראשי (${primaryFolder}), משני (${secondaryFolder})`);

    // מניעת כפילויות של אותה שיחה
    if (callId && processedCalls.has(callId)) {
      console.log("🔄 [חג כפול] זוהתה קריאה כפולה לאותו Call ID, מחזיר מעבר תיקיה.");
      processedCalls.delete(callId);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.send("go_to_folder=/1");
    }

    const token = params.token || params.TOKEN || "WU1BUElL.apik_H8E4CZtg_8iQ0kMQLYzFrw.X5JSBHi5D-dw_BWfX_3vIrgoR9jYSzUdiITDwdsIHCM";
    const groqApiKey = (process.env.GROQ_API_KEY || "").trim();
    const geminiApiKey = (process.env.GEMINI_API_KEY || "").trim();

    let audioBuffer = null;
    const possiblePaths = [];

    if (params.path) possiblePaths.push(params.path);
    if (params.file) possiblePaths.push(params.file);
    possiblePaths.push(`ivr2:/${secondaryFolder}/last.wav`);
    possiblePaths.push(`ivr2:/${primaryFolder}/last.wav`);

    console.log("📥 [שלב הורדה] מנסה להוריד קובץ שמע מימות המשיח...");

    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;

      try {
        console.log(`🔍 מנסה נתיב: ${cleanPath}`);
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 4000 });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          console.log(`✅ [הורדה הצליחה] הקובץ הורד בהצלחה מנתיב: ${cleanPath} (גודל: ${audioBuffer.length} בתים)`);
          break;
        }
      } catch (err) {
        console.log(`⚠️ נכשל בנתיב ${cleanPath}, ממשיך הלאה...`);
      }
    }

    if (!audioBuffer) {
      console.log("❌ [שגיאת שמע] לא נמצאה הקלטה תקינה באף אחד מהנתיבים!");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.send("id_list_message=m-לא נמצאה הקלטה תקינה");
    }

    let transcribedText = "";

    // שלב תמלול ב-Groq
    if (groqApiKey) {
      console.log("🎙️ [שלב תמלול] שולח את הקובץ לתמלול ב-Groq (Whisper)...");
      try {
        const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
        let formDataHeader = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`;
        formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nhe\r\n`;
        formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
        const formDataFooter = `\r\n--${boundary}--\r\n`;

        const fullBuffer = Buffer.concat([
          Buffer.from(formDataHeader, "utf-8"),
          audioBuffer,
          Buffer.from(formDataFooter, "utf-8")
        ]);

        const transcriptionResponse = await axios.post(
          "https://api.groq.com/openai/v1/audio/transcriptions",
          fullBuffer,
          {
            headers: {
              "Authorization": `Bearer ${groqApiKey}`,
              "Content-Type": `multipart/form-data; boundary=${boundary}`
            },
            timeout: 5000
          }
        );
        transcribedText = transcriptionResponse.data?.text || "";
        console.log(`📝 [תמלול הושלם] הטקסט שזוהה: "${transcribedText}"`);
      } catch (err) {
        console.log(`⚠️ [שגיאת תמלול ב-Groq]: ${err.message}`);
      }
    } else {
      console.log("ℹ️ מפתח Groq אינו מוגדר, מדלג על שלב התמלול.");
    }

    let finalAnswerText = "";
    const systemInstruction = "ענה בעברית פשוטה בלבד, ללא סימני פיסוק, ללא מספרים, עד 2 משפטים.";

    // שלב הפקת תשובה מ-Gemini
    if (geminiApiKey) {
      console.log("🤖 [שלב AI] שולח בקשה למודל Gemini...");
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiApiKey}`;
        const response = await axios.post(geminiUrl, {
          contents: [
            { role: "user", parts: [{ text: systemInstruction }, { text: transcribedText || "שלום" }] }
          ]
        }, { timeout: 6000 });

        finalAnswerText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        console.log(`💡 [תשובת AI גולמית]: "${finalAnswerText}"`);
      } catch (err) {
        console.log(`⚠️ [שגיאת Gemini]: ${err.message}`);
      }
    } else {
      console.log("⚠️ מפתח Gemini אינו מוגדר!");
    }

    if (!finalAnswerText) {
      finalAnswerText = "שגיאה בעיבוד הנתונים";
      console.log("⚠️ לא התקבלה תשובה מה-AI, משתמש בברירת מחדל.");
    }

    const cleanText = formatTextForYemot(finalAnswerText);
    console.log(`✨ [טקסט סופי נקי לימות המשיח]: "${cleanText}"`);

    if (callId) {
      processedCalls.set(callId, true);
      setTimeout(() => processedCalls.delete(callId), 5000);
    }

    const totalTime = Date.now() - startTime;
    console.log(`⏱️ [סיום תהליך] זמן כולל לעיבוד הקריאה: ${totalTime}ms`);
    console.log("==================================================\n");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(`id_list_message=m-${encodeURIComponent(cleanText)}`);

  } catch (error) {
    console.error("❌ [שגיאה קריטית במערכת]:", error.stack || error.message);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send("id_list_message=m-שגיאה במערכת");
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 [שרת הופעל] השרת רץ בהצלחה על פורט ${PORT} ומוכן לקריאות!`);
});
