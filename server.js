require("dotenv").config();
console.log("SERVER START");
const fetch = require("node-fetch");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const mysql = require("mysql2/promise");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Cek API Key OpenRouter
if (!process.env.OPENROUTER_API_KEY) {
  console.warn("⚠️  OPENROUTER_API_KEY belum diatur. Generate quiz tidak akan berfungsi.");
} else {
  console.log("✅ OpenRouter API Key ditemukan.");
}

let db;

// ==================== FUNGSI MIGRASI ====================
async function runMigrations(database) {
  console.log("Menjalankan migrasi database...");

  // Tabel users
  await database.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50),
      email VARCHAR(100),
      password VARCHAR(255),
      learning_style VARCHAR(20) DEFAULT 'reading',
      visual_score FLOAT DEFAULT 0,
      auditory_score FLOAT DEFAULT 0,
      reading_score FLOAT DEFAULT 0,
      kinesthetic_score FLOAT DEFAULT 0
    )
  `);

  // Tabel classification_rules
  await database.execute(`
    CREATE TABLE IF NOT EXISTS classification_rules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      visual_weight FLOAT DEFAULT 1,
      auditory_weight FLOAT DEFAULT 1,
      reading_weight FLOAT DEFAULT 1,
      kinesthetic_weight FLOAT DEFAULT 1
    )
  `);

  const [existingRules] = await database.execute(
    "SELECT COUNT(*) AS cnt FROM classification_rules"
  );
  if (existingRules[0].cnt === 0) {
    await database.execute(
      `INSERT INTO classification_rules (visual_weight, auditory_weight, reading_weight, kinesthetic_weight)
       VALUES (1, 1, 1, 1)`
    );
  }

  // Tabel activities
  await database.execute(`
    CREATE TABLE IF NOT EXISTS activities (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      type ENUM('video','teks','praktik') NOT NULL,
      content_url VARCHAR(500),
      style_target ENUM('visual','auditory','reading','kinesthetic')
    )
  `);

  // Tabel ai_generated_quizzes
  await database.execute(`
    CREATE TABLE IF NOT EXISTS ai_generated_quizzes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      topic VARCHAR(200),
      num_questions INT,
      questions JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("✅ Migrasi database selesai.");
}

// ==================== INISIALISASI KONEKSI DB ====================
(async () => {
  try {
    db = await mysql.createConnection({
      host: process.env.DB_HOST || "localhost",
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME || "elearning_ai_final",
      ssl: { rejectUnauthorized: false },
    });
    console.log("✅ MySQL terhubung ke Aiven");
    await runMigrations(db);
  } catch (err) {
    console.error("❌ Koneksi/migrasi DB gagal:", err.message);
  }
})();

// ==================== ENDPOINT ANALISIS GAYA BELAJAR ====================
app.post("/analyze", async (req, res) => {
  const { answers, userId } = req.body;
  if (!answers || answers.length !== 8) {
    return res.status(400).json({ success: false, message: "Jawaban tidak lengkap" });
  }

  const scores = { visual: 0, auditory: 0, reading: 0, kinesthetic: 0 };
  for (let a of answers) scores[a]++;

  let rules = [{ visual_weight: 1, auditory_weight: 1, reading_weight: 1, kinesthetic_weight: 1 }];
  if (db) {
    try {
      const [rows] = await db.execute("SELECT * FROM classification_rules ORDER BY id DESC LIMIT 1");
      if (rows.length) rules = rows;
    } catch (e) {
      console.warn("Gagal ambil classification_rules, pakai default.");
    }
  }

  const w = rules[0];
  const weighted = {
    visual: scores.visual * w.visual_weight,
    auditory: scores.auditory * w.auditory_weight,
    reading: scores.reading * w.reading_weight,
    kinesthetic: scores.kinesthetic * w.kinesthetic_weight,
  };

  const maxStyle = Object.keys(weighted).reduce((a, b) =>
    weighted[a] > weighted[b] ? a : b
  );

  // ============ AKTIVITAS DENGAN LINK BARU ============
  let activities = [];
  if (db) {
    try {
      const [countResult] = await db.execute("SELECT COUNT(*) AS cnt FROM activities");
      if (countResult[0].cnt === 0) {
        try {
          await db.execute(`
            INSERT INTO activities (title, type, content_url, style_target) VALUES
            ('Artikel: Pengantar Pemrograman', 'teks', 'https://dte.telkomuniversity.ac.id/en/pengantar-pemrograman-konsep-variabel-tipe-data-dan-struktur-kontrol', 'reading'),
            ('Video: Visualisasi Data untuk Pemula', 'video', 'https://www.youtube.com/embed/R_MbWn5wBis', 'visual'),
            ('Podcast: Mengapa Sains Itu Seru?', 'video', 'https://www.youtube.com/embed/Uc3mUIF1bP0', 'auditory'),
            ('Game: Flexbox Froggy', 'praktik', 'https://flexboxfroggy.com', 'kinesthetic')
          `);
          console.log("✅ Data aktivitas contoh ditambahkan.");
        } catch (insertErr) {
          console.warn("⚠️ Gagal menambahkan data contoh:", insertErr.message);
        }
      }

      const [rows] = await db.execute("SELECT * FROM activities WHERE style_target = ?", [maxStyle]);
      activities = rows;
      console.log(`Aktivitas ditemukan untuk gaya ${maxStyle}: ${activities.length}`);
    } catch (err) {
      console.error("Gagal ambil aktivitas dari DB:", err);
    }
  }

  // Fallback aktivitas dengan link baru
  if (activities.length === 0) {
    console.warn("⚠️ Tidak ada aktivitas, menggunakan fallback.");
    activities = [
      {
        id: 0,
        title: "Artikel: Pengantar Pemrograman",
        type: "teks",
        content_url: "https://dte.telkomuniversity.ac.id/en/pengantar-pemrograman-konsep-variabel-tipe-data-dan-struktur-kontrol",
        style_target: "reading",
      },
      {
        id: 0,
        title: "Video: Visualisasi Data untuk Pemula",
        type: "video",
        content_url: "https://www.youtube.com/embed/R_MbWn5wBis",
        style_target: "visual",
      },
      {
        id: 0,
        title: "Podcast: Mengapa Sains Itu Seru?",
        type: "video",
        content_url: "https://www.youtube.com/embed/Uc3mUIF1bP0",
        style_target: "auditory",
      },
      {
        id: 0,
        title: "Game: Flexbox Froggy",
        type: "praktik",
        content_url: "https://flexboxfroggy.com",
        style_target: "kinesthetic",
      },
    ].filter((a) => a.style_target === maxStyle);
  }

  res.json({
    success: true,
    learning_style: maxStyle,
    scores: weighted,
    activities: activities,
  });
});

// ==================== UPDATE PERFORMANCE (FIX: Tidak wajib DB) ====================
app.post("/update_performance", async (req, res) => {
  const { userId, activity_id, score_performance, old_style } = req.body;
  if (!userId || !activity_id) {
    return res.status(400).json({ success: false, message: "userId dan activity_id diperlukan" });
  }

  if (!db) {
    return res.json({
      success: true,
      new_learning_style: old_style || "reading",
      message: "Profil belum diperbarui karena database belum siap. Silakan coba lagi nanti.",
    });
  }

  try {
    let styleTarget = old_style || "reading";
    if (activity_id !== 999) {
      const [act] = await db.execute("SELECT style_target FROM activities WHERE id = ?", [activity_id]);
      if (act.length) styleTarget = act[0].style_target;
    }

    const increment = (score_performance / 100) * 2;
    await db.execute(
      `UPDATE users SET ${styleTarget}_score = ${styleTarget}_score + ? WHERE id = ?`,
      [increment, userId]
    );

    const [user] = await db.execute(
      "SELECT visual_score, auditory_score, reading_score, kinesthetic_score FROM users WHERE id = ?",
      [userId]
    );
    if (user.length) {
      const u = user[0];
      const newScores = {
        visual: u.visual_score,
        auditory: u.auditory_score,
        reading: u.reading_score,
        kinesthetic: u.kinesthetic_score,
      };
      let newStyle = Object.keys(newScores).reduce((a, b) =>
        newScores[a] > newScores[b] ? a : b
      );
      await db.execute("UPDATE users SET learning_style = ? WHERE id = ?", [newStyle, userId]);
      return res.json({ success: true, new_learning_style: newStyle });
    }
    res.json({ success: true, new_learning_style: old_style || "reading" });
  } catch (err) {
    console.error("Update performa error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== GENERATE QUIZ (FIX: Tidak wajib DB) ====================
app.post("/generate-quiz", async (req, res) => {
  const { topic, numQuestions, learningStyle, userId } = req.body;
  if (!topic || !numQuestions) {
    return res.status(400).json({ success: false, message: "Topik dan jumlah soal diperlukan" });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({
      success: false,
      message: "API Key OpenRouter belum dikonfigurasi.",
    });
  }

  const model = "tencent/hy3-preview:free";

  let styleInstruction = "";
  if (learningStyle === "visual")
    styleInstruction = "Gunakan deskripsi visual, diagram, atau skenario yang mudah dibayangkan.";
  else if (learningStyle === "auditory")
    styleInstruction = "Gunakan skenario percakapan atau narasi.";
  else if (learningStyle === "reading")
    styleInstruction = "Gunakan teks yang detail dan deskriptif.";
  else if (learningStyle === "kinesthetic")
    styleInstruction = "Gunakan skenario praktik langsung.";

  const prompt = `Buatkan ${numQuestions} soal pilihan ganda tentang "${topic}". ${styleInstruction} Setiap soal memiliki 4 pilihan (A, B, C, D) dan satu jawaban benar. Format respons harus JSON array dengan struktur:
    [
        {
            "question": "teks soal",
            "options": ["pilihan A", "pilihan B", "pilihan C", "pilihan D"],
            "correct": "huruf jawaban (A/B/C/D)",
            "explanation": "penjelasan singkat"
        }
    ]
    Hanya kirim JSON, tanpa teks tambahan. Batasi total jawaban maksimal 500 kata dalam bahasa Indonesia.`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8080",
        "X-Title": "elearning_ai_final",
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    if (data.error) {
      console.error("OpenRouter error:", data.error);
      return res.status(500).json({ success: false, message: data.error.message });
    }

    let content = data.choices[0].message.content;
    content = content.replace(/```json/g, "").replace(/```/g, "").trim();
    const quizData = JSON.parse(content);
    if (!Array.isArray(quizData) || quizData.length !== numQuestions) {
      throw new Error("Format JSON tidak sesuai");
    }

    if (db && userId) {
      try {
        await db.execute(
          "INSERT INTO ai_generated_quizzes (user_id, topic, num_questions, questions) VALUES (?, ?, ?, ?)",
          [userId, topic, numQuestions, JSON.stringify(quizData)]
        );
        console.log("✅ Quiz tersimpan ke database.");
      } catch (dbError) {
        console.warn("⚠️ Gagal menyimpan quiz ke database:", dbError.message);
      }
    }

    res.json({ success: true, questions: quizData });
  } catch (err) {
    console.error("Generate quiz error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server AI berjalan di port ${PORT}`);
});
