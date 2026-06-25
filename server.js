require("dotenv").config();
console.log("🚀 SERVER START");

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");

const app = express();
const PORT = process.env.PORT || 3000;

// ================== CORS ==================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());

// ================== LOGGER ==================
app.use((req, res, next) => {
  console.log(req.method, req.url);
  next();
});

// ================== POOL DATABASE ==================
let pool = null;

(async () => {
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,   // maksimal 10 koneksi
      queueLimit: 0
    });

    // Tes koneksi awal
    const connection = await pool.getConnection();
    console.log("✅ Database terhubung (pool)");
    connection.release();

    // Jalankan migrasi setelah pool siap
    await runMigrations(pool);
  } catch (err) {
    console.error("❌ Gagal koneksi database:", err.message);
    pool = null;
  }
})();

// ================== MIGRASI ==================
async function runMigrations(pool) {
  console.log("📦 Menjalankan migrasi...");
  const createUsersTable =
    "CREATE TABLE IF NOT EXISTS users (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "username VARCHAR(50)," +
    "email VARCHAR(100)," +
    "password VARCHAR(255)," +
    "learning_style VARCHAR(20) DEFAULT 'reading'," +
    "visual_score FLOAT DEFAULT 0," +
    "auditory_score FLOAT DEFAULT 0," +
    "reading_score FLOAT DEFAULT 0," +
    "kinesthetic_score FLOAT DEFAULT 0)";
  await pool.execute(createUsersTable);

  const createClassificationRulesTable =
    "CREATE TABLE IF NOT EXISTS classification_rules (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "visual_weight FLOAT DEFAULT 1," +
    "auditory_weight FLOAT DEFAULT 1," +
    "reading_weight FLOAT DEFAULT 1," +
    "kinesthetic_weight FLOAT DEFAULT 1)";
  await pool.execute(createClassificationRulesTable);

  const [rules] = await pool.execute("SELECT COUNT(*) cnt FROM classification_rules");
  if (rules[0].cnt === 0) {
    await pool.execute(
      "INSERT INTO classification_rules (visual_weight,auditory_weight,reading_weight,kinesthetic_weight) VALUES (1,1,1,1)"
    );
  }

  const createActivitiesTable =
    "CREATE TABLE IF NOT EXISTS activities (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "title VARCHAR(200)," +
    "type ENUM('video','teks','praktik')," +
    "content_url VARCHAR(500)," +
    "style_target ENUM('visual','auditory','reading','kinesthetic'))";
  await pool.execute(createActivitiesTable);

  const createQuizzesTable =
    "CREATE TABLE IF NOT EXISTS ai_generated_quizzes (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "user_id INT," +
    "topic VARCHAR(200)," +
    "num_questions INT," +
    "questions LONGTEXT," +
    "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)";
  await pool.execute(createQuizzesTable);

  console.log("✅ Migrasi selesai");
}

// ================== HEALTH CHECK ==================
app.get("/", async (req, res) => {
  if (!pool) {
    return res.json({ status: "OK", server: "AI Backend Running", dbConnected: false });
  }
  try {
    await pool.execute("SELECT 1");
    res.json({ status: "OK", server: "AI Backend Running", dbConnected: true });
  } catch (err) {
    res.json({ status: "OK", server: "AI Backend Running", dbConnected: false });
  }
});

// ================== ANALYZE ==================
app.post("/analyze", async (req, res) => {
  try {
    const { answers } = req.body;
    if (!Array.isArray(answers) || answers.length !== 8) {
      return res.status(400).json({ success: false, message: "Jawaban tidak lengkap" });
    }
    const scores = { visual: 0, auditory: 0, reading: 0, kinesthetic: 0 };
    answers.forEach(a => { if (scores.hasOwnProperty(a)) scores[a]++; });

    const learning_style = Object.keys(scores).reduce((a, b) => scores[a] > scores[b] ? a : b);

    let activities = [];
    if (pool) {
      try {
        const [rows] = await pool.execute(
          "SELECT id, title, type, content_url, style_target FROM activities WHERE style_target = ?",
          [learning_style]
        );
        activities = rows || [];
      } catch (dbErr) {
        console.error("Error fetching activities:", dbErr);
      }
    }

    return res.json({ success: true, learning_style, scores, activities });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ================== HELPER: GEMINI REST API ==================
async function callGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY tidak diatur. Tambahkan di environment variables Railway.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API Error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini tidak menghasilkan teks");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// ================== GENERATE QUIZ ==================
app.post("/generate-quiz", async (req, res) => {
  try {
    const {
      topic = "umum",
      numQuestions = 3,
      learningStyle = "reading",
      userId = null
    } = req.body;
    const jumlah = Number(numQuestions) || 3;

    const prompt =
      `Buat ${jumlah} soal pilihan ganda tentang "${topic}" ` +
      `dengan gaya belajar "${learningStyle}". ` +
      `Format output HARUS JSON seperti ini: ` +
      `[{"question": "Pertanyaan", "options": ["A. ...", "B. ...", "C. ...", "D. ..."], "correct": "A", "explanation": "Penjelasan"}] ` +
      `Jangan tambahkan teks apa pun selain JSON.`;

    const raw = await callGemini(prompt);

    // Bersihkan markdown
    let cleaned = raw.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("Format JSON tidak ditemukan");

    const jsonText = cleaned.substring(start, end + 1);
    let questionsArray = JSON.parse(jsonText);
    if (!Array.isArray(questionsArray)) questionsArray = [questionsArray];

    // Simpan ke DB (jika pool tersedia)
    if (pool) {
      try {
        await pool.execute(
          "INSERT INTO ai_generated_quizzes (user_id, topic, num_questions, questions) VALUES (?, ?, ?, ?)",
          [userId, topic, jumlah, JSON.stringify(questionsArray)]
        );
        console.log("✅ Quiz disimpan");
      } catch (dbErr) {
        console.warn("Gagal simpan quiz:", dbErr.message);
      }
    }

    return res.json({ success: true, questions: questionsArray });
  } catch (err) {
    console.error("Generate Quiz Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ================== UPDATE PERFORMANCE ==================
app.post("/update_performance", (req, res) => {
  res.json({ success: true, new_learning_style: "reading" });
});

// ================== GET ALL ACTIVITIES ==================
app.get("/activities", async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, message: "Database tidak terhubung" });
  try {
    const [activities] = await pool.execute("SELECT id, title, type, content_url, style_target FROM activities ORDER BY id DESC");
    res.json({ success: true, activities });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ================== ADD ACTIVITY ==================
app.post("/add-activity", async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, message: "Database tidak terhubung" });
  const { title, type, content_url, style_target } = req.body;
  if (!title || !type || !content_url || !style_target) return res.status(400).json({ success: false, message: "Data tidak lengkap" });
  await pool.execute("INSERT INTO activities (title, type, content_url, style_target) VALUES (?, ?, ?, ?)", [title, type, content_url, style_target]);
  res.json({ success: true, message: "Aktivitas ditambahkan" });
});

// ================== DELETE ACTIVITY ==================
app.delete("/activity/:id", async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, message: "Database tidak terhubung" });
  await pool.execute("DELETE FROM activities WHERE id = ?", [req.params.id]);
  res.json({ success: true, message: "Aktivitas dihapus" });
});

// ================== SEED ACTIVITIES ==================
app.post("/seed-activities", async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, message: "Database tidak terhubung" });
  const sample = [
    { title: "Video - Matematika", type: "video", content_url: "https://www.youtube.com/embed/dQw4w9WgXcQ", style_target: "visual" },
    { title: "Teks - Sejarah", type: "teks", content_url: "https://example.com/sejarah.html", style_target: "reading" },
    { title: "Praktik - Coding JS", type: "praktik", content_url: "https://example.com/js-practice", style_target: "kinesthetic" },
    { title: "Audio - Bhs Inggris", type: "video", content_url: "https://www.youtube.com/embed/example", style_target: "auditory" },
    { title: "Infografis - Biologi", type: "video", content_url: "https://www.youtube.com/embed/biology", style_target: "visual" }
  ];
  let count = 0;
  for (const a of sample) {
    try {
      await pool.execute("INSERT INTO activities (title, type, content_url, style_target) VALUES (?, ?, ?, ?)", [a.title, a.type, a.content_url, a.style_target]);
      count++;
    } catch (e) { console.warn("Mungkin sudah ada:", e.message); }
  }
  res.json({ success: true, message: `${count} aktivitas ditambahkan` });
});

// ================== START ==================
app.listen(PORT, () => console.log(`✅ Server berjalan di port ${PORT}`));
