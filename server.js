const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

// זיכרון מטמון למניעת כפילויות מקריאות חוזרות של ימות המשיח
const responseCache = new Map();

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const callId = params.ApiCallId || params.ApiYFCallId;

    console.log("--- התקבלה קריאה חדשה ---");
    console.log("Call ID:", callId);

    // אם הקריאה הזו כבר טופלה בשניות האחרונות, מחזירים את התשובה השמורה
    if (callId && responseCache.has(callId)) {
      console.log(`קריאה כפולה זוהתה עבור ${callId}, מחזיר תשובה מהמטמון...`);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(responseCache.get(callId));
    }

    const token = params.token || params.TOKEN || "WU1BUElL.apik_H8E4CZtg_8iQ0kMQLYzFrw.X5JSBHi5D-dw_BWfX_3vIrgoR9jYSzUdiITDwdsIHCM";
    const primaryFolder = params.SHM || "2";
    const secondaryFolder = params.SHL || "1";
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.error("שגיאה: GEMINI_API_KEY אינו מוגדר ב-Render!");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-מפתח ה-API אינו מוגדר בשרת&go_to_folder=/${secondaryFolder}`);
    }

    let audioBuffer = null;
    const possiblePaths = [];

    if (params.path) possiblePaths.push(params.path);
    if (params.file) possiblePaths.push(params.file);

    possiblePaths.push(`ivr2:/${secondaryFolder}/last.wav`);
    possiblePaths.push(`ivr2:/${primaryFolder}/last.wav`);

    // הורדת השמע מימות המשיח
    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;
      
      console.log("מנסה להוריד מנתיב:", cleanPath);

      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          console.log(`הקובץ הורד בהצלחה מ-${cleanPath}! גודל: ${audioBuffer.length} bytes`);
          break;
        }
      } catch (err) {
        console.log(`לא נמצא קובץ בנתיב: ${cleanPath}`);
      }
    }

    if (!audioBuffer) {
      console.error("לא נמצאה הקלטה באף נתיב שנבדק.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-לא נמצאה הקלטה תקינה אנא הקלט שוב&go_to_folder=/${secondaryFolder}`);
    }

    // רשימת מודלים למקרה של עומס
    const modelsToTry = [
      params.MODEL || "gemini-2.5-flash",
      "gemini-1.5-flash",
      "gemini-2.0-flash"
    ];

    const payload = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "אתה עוזר קולי בשיחת טלפון. ענה בעברית פשוטה, קצרה וברורה (עד 2 משפטים). אל תשתמש באימוג'ים או תווים מיוחדים."
            },
            {
              inlineData: {
                mimeType: "audio/wav",
                data: audioBuffer.toString("base64")
              }
            }
          ]
        }
      ]
    };

    let responseData = null;

    for (const model of modelsToTry) {
      try {
        console.log(`מנסה לשלוח ל-Gemini מודל: ${model}...`);
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        
        const response = await axios.post(geminiUrl, payload, {
          headers: { "Content-Type": "application/json" },
          timeout: 15000
        });

        if (response.data) {
          responseData = response.data;
          console.log(`התקבלה תשובה בהצלחה מהמודל ${model}!`);
          break;
        }
      } catch (modelError) {
        console.warn(`המודל ${model} נכשל/עמוס. מנסה את הבא...`);
      }
    }

    if (!responseData) {
      throw new Error("כל המודלים עמוסים כרגע.");
    }

    const rawText = responseData?.candidates?.[0]?.content?.parts?.[0]?.text || "לא התקבלה תשובה";
    const cleanText = rawText.replace(/["'\n\r&?=<>/]/g, " ").trim();
    console.log("תשובת Gemini:", cleanText);

    const finalResponse = `id_list_message=t-${cleanText}&go_to_folder=/${secondaryFolder}`;

    // שמירת התשובה במטמון ל-2 דקות כדי למנוע קריסות בקריאה כפולה
    if (callId) {
      responseCache.set(callId, finalResponse);
      setTimeout(() => responseCache.delete(callId), 120000);
    }

    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(finalResponse);

  } catch (error) {
    console.error("שגיאה בעיבוד מול Gemini:", error.message);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-חלה שגיאה בעיבוד ההודעה אנא נסה שנית&go_to_folder=/1`);
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
