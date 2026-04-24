const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Your connection string
const pool = new Pool({
  connectionString: "postgresql://postgres:<your_password>@localhost:5432/major_advisor",
});

// SAVE student data
app.post('/api/students', async (req, res) => {
  const student = req.body;
  try {
    const query = `
      INSERT INTO students (user_id, email, first_name, last_name, full_data)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id) 
      DO UPDATE SET full_data = EXCLUDED.full_data, updated_at = NOW()
      RETURNING *;
    `;
    const values = [
      student.user_id, 
      student.personal_info.email, 
      student.personal_info.first_name, 
      student.personal_info.last_name, 
      student
    ];
    const result = await pool.query(query, values);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(5000, () => console.log('Server running on port 5000'));
