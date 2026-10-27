// ==========================================
// ⚙️ קובץ הגדרות מערכת, מילים חסומות וטריגרים
// ==========================================

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

module.exports = {
  personaTriggers: ["תתנהג כמו", "מעכשיו אתה", "דבר כמו", "תדבר כמו", "תהיה"],
  
  searchKeywords: ["חפש", "חדשות", "עדכון", "היום", "מי", "מה", "איפה", "מתי", "כמה", "איך", "תוצאות", "מזג אוויר", "תוצאה", "מחיר", "שיר", "להשמיע", "להוריד", "נגן", "search", "news", "today", "who", "what", "where", "when", "how", "song", "play", "music"],

  resetTriggers: [
    "תתחיל מחדש", "תתחילי מחדש", "אפס שיחה", "איפוס שיחה",
    "שיחה חדשה", "התחל מחדש", "תמחק היסטוריה", "ניקוי היסטוריה"
  ].map(normalizeText),

  deepDetailsTriggers: [
    "תתעמק", "תתעמקי", "תרחיב", "תרחיבי", "בהרחבה",
    "תפרט", "תפרטי", "עוד מידע", "פירוט", "מידע מפורט"
  ].map(normalizeText),

  switchToEnglishTriggers: [
    "עבור לאנגלית", "דבר אנגלית", "אנגלית", "switch to english", "english please", "speak english"
  ].map(normalizeText),

  switchToHebrewTriggers: [
    "עבור לעברית", "דבר עברית", "עברית", "switch to hebrew", "hebrew please", "speak hebrew"
  ].map(normalizeText),

  blockedKeywords: [
    "סקס", "פורנו", "עירום", "זונה", "שרמוטה", "אונס",
    "זין", "כוס", "מזדיין", "להזדיין", "זיון", "מציצה",
    "סרט כחול", "אנאלי", "אוראלי", "גורן", "סטריפטיז", "איכסה"
  ].map(normalizeText),

  blockedResponseMarker: normalizeText("המפתחים שלי הגדירו לי שאסור לי לענות על זה"),
  bannedUserResponse: "חשבונך נחסם לשימוש במערכת עקב חריגה מוגזמת מכללי השימוש",

  getWarningMessage: (attempts) => {
    if (attempts === 1) return "המפתחים שלי הגדירו שאסור לי לענות על זה זוהי אזהרה ראשונה מתוך שלוש במידה ותגיע לשלוש אזהרות תחסם מהמערכת";
    if (attempts === 2) return "המפתחים שלי הגדירו שאסור לי לענות על זה זוהי אזהרה שנייה מתוך שלוש באזהרה הבאה תחסם מהמערכת";
    return "חשבונך נחסם לשימוש במערכת עקב חריגה מוגזמת מכללי השימוש";
  }
};
