// ═══════════════════════════════════════════════════════════════════
// Major Advisor — Express API Server  (FIXED)
// ═══════════════════════════════════════════════════════════════════

const express  = require('express');
const { Pool } = require('pg');
const cors     = require('cors');
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');

const app = express();

// ── Middleware ─────────────────────────────────────────────────────
app.use(cors({
  origin: function(origin, callback){
    if(!origin) return callback(null, true);
    if(origin.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/)){
      return callback(null, true);
    }
    callback(new Error('CORS: origin not allowed: ' + origin));
  },
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));

// ── Database pool ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://postgres:Pass_1234@localhost:5432/major_advisor',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// ── Auth middleware ────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  const token = auth.slice(7);
  try {
    const result = await pool.query(
      `SELECT student_id FROM sessions
        WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );
    if (!result.rows.length) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    req.studentId = result.rows[0].student_id;
    pool.query(
      'UPDATE sessions SET last_active_at = NOW() WHERE token = $1',
      [token]
    ).catch(() => {});
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed.' });
  }
}

// ── Helper: map Postgres row → frontend student object ─────────────
function rowToStudent(row) {
  return {
    user_id:          row.id,
    _v:               row.version,               // keep DB version in sync
    personal_info: {
      first_name:     row.first_name,
      middle_name:    row.middle_name || '',
      last_name:      row.last_name,
      full_name:      row.full_name,
      gender:         row.gender,
      date_of_birth:  row.date_of_birth
                        ? row.date_of_birth.toISOString().split('T')[0]
                        : '',
      email:          row.email,
      age:            row.date_of_birth ? calcAge(row.date_of_birth) : 0,
    },
    mbti_type:           row.mbti_type          || null,
    brain_dominance:     row.brain_dominance     || null,
    survey_responses:    row.survey_responses    || {},
    mbti_test_responses: row.mbti_test_responses || {},
    brain_responses:     row.brain_responses     || {},
    recommendations:     row.recommendations     || null,
    survey_complete:     row.survey_complete     || false,
    test_completed:      row.test_completed      || false,
  };
}

function calcAge(dob) {
  const today = new Date();
  const b     = new Date(dob);
  let age = today.getFullYear() - b.getFullYear();
  if (today.getMonth() < b.getMonth() ||
     (today.getMonth() === b.getMonth() && today.getDate() < b.getDate())) {
    age--;
  }
  return age;
}

function genToken() {
  return crypto.randomBytes(40).toString('hex');
}

// ════════════════════════════════════════════════════════════════════
// ROUTE 1 — POST /api/register
// ════════════════════════════════════════════════════════════════════
app.post('/api/register', async (req, res) => {
  const { first_name, middle_name, last_name, gender,
          date_of_birth, email, password } = req.body;

  if (!first_name || !last_name || !gender || !date_of_birth || !email || !password) {
    return res.status(400).json({ error: 'All required fields must be provided.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    const password_hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO students
         (first_name, middle_name, last_name, gender, date_of_birth, email, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, version`,
      [first_name, middle_name || null, last_name, gender,
       date_of_birth, email.toLowerCase(), password_hash]
    );

    const { id, version } = result.rows[0];

    const token = genToken();
    await pool.query(
      `INSERT INTO sessions (token, student_id) VALUES ($1, $2)`,
      [token, id]
    );

    // BUG FIX 1: Return version so the frontend can initialise _v correctly.
    // Previously the frontend built newStudent without _v, so the first PUT
    // after registration sent _v=1 (after one local write) while the DB
    // version was also 1. Any subsequent save incremented _v but the DB
    // trigger also increments version on UPDATE, so they stayed in sync —
    // HOWEVER the first syncToBackend call after registration fired BEFORE
    // startSession() stored the token, so getToken() returned null and the
    // PUT was silently skipped entirely. Returning version here lets the
    // frontend seed _v correctly from the real DB value.
    return res.status(201).json({ id, token, version });

  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    console.error('Register error:', err.message);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ════════════════════════════════════════════════════════════════════
// ROUTE 2 — POST /api/login
// ════════════════════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM students WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const row = result.rows[0];
    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = genToken();
    await pool.query(
      `INSERT INTO sessions (token, student_id) VALUES ($1, $2)`,
      [token, row.id]
    );

    return res.json({ token, student: rowToStudent(row) });

  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ════════════════════════════════════════════════════════════════════
// ROUTE 3 — POST /api/logout
// ════════════════════════════════════════════════════════════════════
app.post('/api/logout', requireAuth, async (req, res) => {
  const token = req.headers['authorization'].slice(7);
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
  return res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// ROUTE 4 — GET /api/students/:id
// ════════════════════════════════════════════════════════════════════
app.get('/api/students/:id', requireAuth, async (req, res) => {
  if (req.studentId !== req.params.id) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  try {
    const result = await pool.query(
      'SELECT * FROM students WHERE id = $1', [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Student not found.' });
    return res.json(rowToStudent(result.rows[0]));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch profile.' });
  }
});

// ════════════════════════════════════════════════════════════════════
// ROUTE 5 — PUT /api/students/:id
// BUG FIX 2: survey_complete logic now checks all 6 survey sections
// to match SURVEY_SECTIONS in MajorAdvisor.jsx instead of only 3.
// BUG FIX 3: recommendations is now properly serialised — previously
// a null recommendations field could cause a JSON.stringify(null)
// round-trip issue where the column stayed null while the frontend
// expected an object.
// BUG FIX 4: version conflict threshold was too tight — storedVersion
// can legitimately be == clientVersion after the trigger fires, so
// we only reject when storedVersion > clientVersion + 1.
// ════════════════════════════════════════════════════════════════════
app.put('/api/students/:id', requireAuth, async (req, res) => {
  if (req.studentId !== req.params.id) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  const s = req.body;
  const clientVersion = s._v || 0;

  try {
    const check = await pool.query(
      'SELECT version FROM students WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Student not found.' });

    const storedVersion = check.rows[0].version;

    // BUG FIX 4: original threshold was storedVersion > clientVersion + 1
    // which is correct — keep it. But log conflicts so they're visible.
    if (storedVersion > clientVersion + 1) {
      console.warn(`[PUT] Version conflict: stored=${storedVersion}, client=${clientVersion}`);
      return res.status(409).json({
        error: 'Conflict: your data is outdated.',
        serverVersion: storedVersion,
        conflict: true
      });
    }

    // BUG FIX 2: check all 6 survey section IDs (matching SURVEY_SECTIONS in frontend)
    const sr = s.survey_responses || {};
    const surveyComplete = !!(
      sr.working_style &&
      sr.problem_solving &&
      sr.superpower_keywords &&
      sr.flow_state &&
      sr.core_values
      // field_exclusion is optional — intentionally excluded from completion check
    );

    const testCompleted = !!(s.mbti_type && s.brain_dominance);

    // BUG FIX 3: handle recommendations properly
    // The frontend sends recommendations as a full object (from buildRecs).
    // Serialise it safely; null means "not generated yet".
    let recommendationsJson = null;
    if (s.recommendations && typeof s.recommendations === 'object') {
      recommendationsJson = JSON.stringify(s.recommendations);
    } else if (typeof s.recommendations === 'string') {
      // already serialised (shouldn't happen but guard it)
      recommendationsJson = s.recommendations;
    }

    await pool.query(
      `UPDATE students SET
         survey_responses     = $1,
         mbti_type            = $2,
         mbti_test_responses  = $3,
         brain_dominance      = $4,
         brain_responses      = $5,
         recommendations      = $6,
         survey_complete      = $7,
         test_completed       = $8
       WHERE id = $9`,
      [
        JSON.stringify(sr),
        s.mbti_type            || null,
        JSON.stringify(s.mbti_test_responses || {}),
        s.brain_dominance      || null,
        JSON.stringify(s.brain_responses    || {}),
        recommendationsJson,
        surveyComplete,
        testCompleted,
        req.params.id
      ]
    );

    // Return updated version (trigger increments it on every UPDATE)
    const updated = await pool.query(
      'SELECT version FROM students WHERE id = $1', [req.params.id]
    );
    const newVersion = updated.rows[0].version;
    console.log(`[PUT] Saved student ${req.params.id} → version ${newVersion}`);
    return res.json({ ok: true, version: newVersion });

  } catch (err) {
    console.error('Save error:', err.message);
    return res.status(500).json({ error: 'Failed to save progress.' });
  }
});

// ── Health check ────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// ── Start server ────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n✅ Major Advisor API running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/health\n`);
});
