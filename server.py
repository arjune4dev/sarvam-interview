"""Small local server for the Hireflow Sarvam interview demo and KIWI workflow bridge."""
import base64
import json
import os
import sqlite3
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlsplit, unquote, parse_qs
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from sarvamai import SarvamAI

ROOT = Path(__file__).resolve().parent
DB_PATH = Path("/tmp/hireflow.db") if os.environ.get("VERCEL") else ROOT / "hireflow.db"


def load_env():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() and value.strip():
            os.environ.setdefault(name.strip(), value.strip().strip('"\''))


load_env()
API_KEY = os.environ.get("SARVAM_API_KEY")
client = SarvamAI(api_subscription_key=API_KEY) if API_KEY else None

SYSTEM_PROMPT = """You are Hireflow, a respectful first-round interviewer. Interview only against the job criteria and candidate evidence provided. Ask one concise question at a time, keep the conversation warm, and probe for concrete examples, decisions, ownership, and outcomes. Follow the staged interview plan supplied for this turn; acknowledge answers briefly, avoid repeating questions, and use a relevant follow-up when an answer lacks detail. Confirm the candidate's preferred name first, then ask qualifications, optional hobbies/interests for rapport, relevant experience, and role competencies. If an earlier answer or profile already provides a stage's information, briefly confirm it or move forward; do not ask it again. Hobbies and personal interests are optional rapport only and must never affect evaluation. Never ask about protected or personal characteristics (including age, caste, religion, disability, family, or marital status). Do not make a hiring decision during the interview. When asked to evaluate, return JSON only with keys: recommendation (Advance, Hold, or Decline), confidence (0-100), summary (one sentence), competencies (array of objects with name, score 1-5, evidence), strengths (array of strings), gaps (array of strings), follow_up (array of strings). Base every claim on job criteria and transcript evidence; identify missing evidence instead of guessing. Do not use education prestige, accent, hobbies, or personal circumstances as proxies for job competence."""

ROLE_RUBRICS = {
    "Product Designer": "Product discovery, user research, interaction design, prototyping, design systems, accessibility, collaboration, and measuring outcomes.",
    "Frontend Engineer": "JavaScript fundamentals, component architecture, accessibility, performance, testing, debugging, and collaboration with design and backend teams.",
    "ML Engineer": "Problem framing, data quality and leakage prevention, feature engineering, model selection, validation strategy, appropriate metrics, deployment, monitoring and drift, reproducibility, and responsible ML trade-offs. Ask for concrete examples and evidence rather than trivia.",
    "Product Manager": "Customer discovery, prioritization, product strategy, success metrics, stakeholder alignment, execution, and learning from outcomes.",
}


@contextmanager
def db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db():
    with db() as connection:
        connection.execute("""CREATE TABLE IF NOT EXISTS candidates (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT DEFAULT '',
            role TEXT NOT NULL, qualification TEXT DEFAULT '', experience TEXT DEFAULT '',
            interests TEXT DEFAULT '', skills TEXT DEFAULT '', stage TEXT DEFAULT 'Applied',
            ai_score INTEGER, scorecard TEXT DEFAULT '', transcript TEXT DEFAULT '',
            reviewer_feedback TEXT DEFAULT '', human_decision TEXT DEFAULT 'Pending recruiter decision',
            created_at TEXT NOT NULL
        )""")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(candidates)")}
        if "reviewer_feedback" not in columns:
            connection.execute("ALTER TABLE candidates ADD COLUMN reviewer_feedback TEXT DEFAULT ''")
        if "human_decision" not in columns:
            connection.execute("ALTER TABLE candidates ADD COLUMN human_decision TEXT DEFAULT 'Pending recruiter decision'")
        connection.execute("""CREATE TABLE IF NOT EXISTS interviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id INTEGER NOT NULL,
            starts_at TEXT NOT NULL, duration_minutes INTEGER NOT NULL DEFAULT 30,
            mode TEXT NOT NULL DEFAULT 'AI voice', language TEXT NOT NULL DEFAULT 'en-IN',
            status TEXT NOT NULL DEFAULT 'Pending KIWI approval', created_at TEXT NOT NULL
        )""")
        if connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0] == 0:
            now = datetime.now(timezone.utc).isoformat()
            connection.executemany(
                "INSERT INTO candidates(name,email,role,qualification,experience,interests,skills,stage,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                [
                    ("Priya Kapoor", "priya.k@email.com", "Product Designer", "", "", "", "", "AI interview", now),
                    ("Rahul Verma", "rahul.v@email.com", "Frontend Engineer", "", "", "", "", "Recruiter review", now),
                    ("Ananya Mehta", "ananya.m@email.com", "Product Manager", "", "", "", "", "Scheduled", now),
                ],
            )


init_db()


def sarvam_chat(messages, max_tokens=500):
    if client is None:
        raise RuntimeError("SARVAM_API_KEY is missing from .env")
    response = client.chat.completions(
        model="sarvam-105b-conversations",
        messages=messages,
        max_tokens=max_tokens,
        reasoning_effort=None,
    )
    return response.choices[0].message.content


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        # Avoid logging request bodies or candidate data.
        super().log_message(fmt, *args)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        size = int(self.headers.get("Content-Length", "0"))
        if size > 12_000_000:
            raise ValueError("Request is too large")
        return json.loads(self.rfile.read(size) or b"{}")

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if any(part.startswith(".") for part in Path(path).parts) or path in {"/hireflow.db", "/server.py", "/sarvam_call.py"}:
            self.send_error(404)
            return
        if path == "/api/candidates":
            with db() as connection:
                rows = connection.execute("SELECT id,name,email,role,qualification,experience,interests,skills,stage,ai_score,scorecard,created_at FROM candidates ORDER BY id DESC").fetchall()
            self.send_json(200, {"candidates": [dict(row) for row in rows]})
            return
        if path == "/api/interviews":
            with db() as connection:
                rows = connection.execute("SELECT interviews.id,interviews.candidate_id,interviews.starts_at,interviews.duration_minutes,interviews.mode,interviews.language,interviews.status,candidates.name,candidates.role FROM interviews JOIN candidates ON candidates.id=interviews.candidate_id ORDER BY interviews.starts_at").fetchall()
            self.send_json(200, {"interviews": [dict(row) for row in rows]})
            return
        if path == "/api/candidate":
            query = parse_qs(urlsplit(self.path).query)
            candidate_id = int((query.get("id") or [0])[0])
            with db() as connection:
                row = connection.execute("SELECT * FROM candidates WHERE id=?", (candidate_id,)).fetchone()
            if not row:
                self.send_json(404, {"error": "Candidate not found"})
            else:
                self.send_json(200, {"candidate": dict(row)})
            return
        return super().do_GET()

    def do_POST(self):
        try:
            if self.path == "/api/interview/turn":
                self.interview_turn()
            elif self.path == "/api/interview/evaluate":
                self.evaluate()
            elif self.path == "/api/candidates":
                self.create_candidate()
            elif self.path == "/api/candidates/stage":
                self.update_candidate_stage()
            elif self.path == "/api/candidates/review":
                self.save_review()
            elif self.path == "/api/interviews":
                self.create_interview()
            elif self.path == "/api/voice/speak":
                self.speak()
            elif self.path == "/api/voice/transcribe":
                self.transcribe()
            elif self.path == "/api/kiwi/action":
                self.kiwi_action()
            else:
                self.send_json(404, {"error": "Unknown endpoint"})
        except (ValueError, RuntimeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            self.send_json(502, {"error": f"Service request failed: {type(exc).__name__}"})

    def interview_turn(self):
        data = self.read_json()
        role = str(data.get("role", "Product Designer"))[:200]
        candidate = str(data.get("candidate", "Candidate"))[:120]
        language = str(data.get("language", "en-IN"))[:20]
        profile = data.get("profile", {})
        if not isinstance(profile, dict):
            profile = {}
        history = data.get("messages", [])[-16:]
        if not isinstance(history, list):
            raise ValueError("messages must be a list")
        stage = sum(1 for item in history if isinstance(item, dict) and item.get("role") == "user")
        stages = ["confirm the candidate's preferred name and ask for a very brief introduction", "ask for the highest qualification and field of study", "ask what the candidate enjoys outside work; make clear this is optional and is for rapport only", "ask for a concise overview of relevant experience", "move into one role-specific competency question, using known profile details and prior answers to personalize it"]
        current_stage = stages[min(stage, len(stages) - 1)]
        rubric = ROLE_RUBRICS.get(role, "Relevant experience, problem solving, communication, collaboration, and ownership.")
        profile_fields = ("name", "qualification", "experience", "interests", "skills")
        profile_summary = "; ".join(f"{key}: {str(profile.get(key))[:500]}" for key in profile_fields if profile.get(key))
        messages = [{"role": "system", "content": f"{SYSTEM_PROMPT}\n\nRole: {role}. Candidate: {candidate}. Interview language: {language}. Role criteria: {rubric}. Known candidate profile: {profile_summary or 'No profile details provided yet.'}. Current stage: {current_stage}. Ask one question for this stage; if the candidate already volunteered this information in an earlier answer, acknowledge it and move to the next stage."}]
        for item in history:
            if isinstance(item, dict) and item.get("role") in {"user", "assistant"}:
                content = str(item.get("content", ""))[:4000]
                if content:
                    messages.append({"role": item["role"], "content": content})
        if len(messages) == 1:
            messages.append({"role": "user", "content": "Start the first-round interview now."})
        self.send_json(200, {"reply": sarvam_chat(messages)})

    def evaluate(self):
        data = self.read_json()
        role = str(data.get("role", "Product Designer"))[:200]
        rubric = str(data.get("rubric", "Role-relevant skills, problem solving, communication, collaboration, and ownership."))[:1500]
        transcript = str(data.get("transcript", ""))[:18000]
        if not transcript.strip():
            raise ValueError("Interview transcript is empty")
        result = sarvam_chat([
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Evaluate this first-round interview for {role}. Use this rubric: {ROLE_RUBRICS.get(role, rubric)}. Ignore the preferred name and hobbies as performance evidence. Assess relevant qualifications only when required by the job criteria. Transcript:\n{transcript}\n\nReturn the required JSON scorecard. This is decision support for a human recruiter; do not claim certainty beyond the evidence."},
        ], max_tokens=900)
        candidate_id = data.get("candidate_id")
        if candidate_id:
            score = None
            try:
                score_data = json.loads(result)
            except (ValueError, TypeError):
                first, last = result.find("{"), result.rfind("}")
                try:
                    score_data = json.loads(result[first:last + 1]) if first >= 0 and last > first else {}
                except ValueError:
                    score_data = {}
            try:
                competency_scores = [max(1, min(5, int(item.get("score")))) for item in score_data.get("competencies", []) if isinstance(item, dict) and item.get("score") is not None]
                score = round(sum(competency_scores) / len(competency_scores) * 20) if competency_scores else None
            except (ValueError, TypeError, AttributeError):
                score = None
            with db() as connection:
                connection.execute("UPDATE candidates SET stage='Recruiter review', ai_score=?, scorecard=?, transcript=? WHERE id=?", (score, result, transcript, int(candidate_id)))
        self.send_json(200, {"scorecard": result})

    def create_candidate(self):
        data = self.read_json()
        name = str(data.get("name", "")).strip()[:120]
        role = str(data.get("role", "Product Designer")).strip()[:120]
        if not name or not role:
            raise ValueError("Candidate name and role are required")
        values = [name, str(data.get("email", "")).strip()[:200], role,
                  str(data.get("qualification", "")).strip()[:500],
                  str(data.get("experience", "")).strip()[:1000],
                  str(data.get("interests", "")).strip()[:500],
                  str(data.get("skills", "")).strip()[:1000], "Applied",
                  datetime.now(timezone.utc).isoformat()]
        with db() as connection:
            cursor = connection.execute("INSERT INTO candidates(name,email,role,qualification,experience,interests,skills,stage,created_at) VALUES(?,?,?,?,?,?,?,?,?)", values)
            candidate_id = cursor.lastrowid
            row = connection.execute("SELECT id,name,email,role,qualification,experience,interests,skills,stage,ai_score,scorecard,created_at FROM candidates WHERE id=?", (candidate_id,)).fetchone()
        self.send_json(201, {"candidate": dict(row)})

    def update_candidate_stage(self):
        data = self.read_json()
        candidate_id = int(data.get("candidate_id", 0))
        stage = str(data.get("stage", "")).strip()
        if stage not in {"Applied", "AI interview", "Recruiter review", "Scheduled", "Offer", "Hired", "Declined"}:
            raise ValueError("Unsupported recruiting stage")
        with db() as connection:
            cursor = connection.execute("UPDATE candidates SET stage=? WHERE id=?", (stage, candidate_id))
        if not cursor.rowcount:
            self.send_json(404, {"error": "Candidate not found"})
            return
        self.send_json(200, {"ok": True, "stage": stage})

    def save_review(self):
        data = self.read_json()
        candidate_id = int(data.get("candidate_id", 0))
        decision = str(data.get("human_decision", "Pending recruiter decision"))
        allowed_decisions = {"Pending recruiter decision", "Advance", "Hold", "Decline"}
        if decision not in allowed_decisions:
            raise ValueError("Choose a valid recruiter decision")
        feedback = str(data.get("reviewer_feedback", "")).strip()[:5000]
        stage = "Declined" if decision == "Decline" else "Recruiter review"
        with db() as connection:
            cursor = connection.execute("UPDATE candidates SET reviewer_feedback=?,human_decision=?,stage=? WHERE id=?", (feedback, decision, stage, candidate_id))
        if not cursor.rowcount:
            self.send_json(404, {"error": "Candidate not found"})
            return
        self.send_json(200, {"ok": True, "human_decision": decision, "stage": stage})

    def create_interview(self):
        data = self.read_json()
        candidate_id = int(data.get("candidate_id", 0))
        starts_at = str(data.get("starts_at", ""))
        try:
            start = datetime.fromisoformat(starts_at.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("Choose a valid interview date and time")
        if start <= datetime.now(timezone.utc):
            raise ValueError("Interview time must be in the future")
        duration = int(data.get("duration_minutes", 30))
        if duration not in {15, 30, 45, 60}:
            raise ValueError("Choose a supported interview duration")
        with db() as connection:
            candidate = connection.execute("SELECT id FROM candidates WHERE id=?", (candidate_id,)).fetchone()
            if not candidate:
                raise ValueError("Choose an existing candidate")
            cursor = connection.execute("INSERT INTO interviews(candidate_id,starts_at,duration_minutes,mode,language,created_at) VALUES(?,?,?,?,?,?)", (candidate_id, start.isoformat(), duration, "AI voice", str(data.get("language", "en-IN"))[:20], datetime.now(timezone.utc).isoformat()))
            connection.execute("UPDATE candidates SET stage='Scheduled' WHERE id=?", (candidate_id,))
            row = connection.execute("SELECT interviews.id,interviews.candidate_id,interviews.starts_at,interviews.duration_minutes,interviews.mode,interviews.language,interviews.status,candidates.name,candidates.role FROM interviews JOIN candidates ON candidates.id=interviews.candidate_id WHERE interviews.id=?", (cursor.lastrowid,)).fetchone()
        self.send_json(201, {"interview": dict(row)})

    def speak(self):
        data = self.read_json()
        text = str(data.get("text", ""))[:1800]
        language = str(data.get("language", "en-IN"))[:20]
        if not text:
            raise ValueError("text is required")
        if client is None:
            raise RuntimeError("SARVAM_API_KEY is missing from .env")
        result = client.text_to_speech.convert(
            text=text, language_code=language, model="bulbul:v4-flash"
        )
        self.send_json(200, {"audio": result.audios[0], "format": "wav"})

    def transcribe(self):
        data = self.read_json()
        audio = base64.b64decode(data.get("audio", ""))
        mime = str(data.get("mime", "audio/webm"))
        language = str(data.get("language", ""))[:20]
        if not audio or len(audio) > 8_000_000:
            raise ValueError("Provide an audio clip smaller than 8 MB")
        if client is None:
            raise RuntimeError("SARVAM_API_KEY is missing from .env")
        import io
        audio_file = io.BytesIO(audio)
        if "webm" in mime:
            audio_file.name = "candidate-audio.webm"
        elif "mp4" in mime or "m4a" in mime:
            audio_file.name = "candidate-audio.m4a"
        else:
            audio_file.name = "candidate-audio.wav"
        response = client.speech_to_text.transcribe(
            file=audio_file, model="saaras:v4", mode="transcribe",
            language_code=language or None,
        )
        self.send_json(200, {"transcript": response.transcript, "language": response.language_code})

    def kiwi_action(self):
        data = self.read_json()
        hook = os.environ.get("KIWI_WORKFLOW_WEBHOOK_URL", "").strip()
        if not hook:
            self.send_json(503, {"error": "Add your KIWI workflow webhook URL as KIWI_WORKFLOW_WEBHOOK_URL in .env."})
            return
        action = str(data.get("action", ""))
        allowed = {"candidate_intake", "schedule_interview", "draft_outreach", "application_status"}
        if action not in allowed:
            raise ValueError("Unsupported KIWI workflow action")
        payload = json.dumps({"source": "hireflow", "action": action, "requires_approval": True, "candidate": data.get("candidate", {}), "details": data.get("details", {})}).encode()
        headers = {"Content-Type": "application/json"}
        token = os.environ.get("KIWI_WEBHOOK_TOKEN", "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = Request(hook, data=payload, headers=headers, method="POST")
        try:
            with urlopen(request, timeout=20) as response:
                result = response.read(100_000).decode("utf-8", "replace")
                self.send_json(response.status, {"ok": True, "result": result[:2000]})
        except HTTPError as exc:
            self.send_json(exc.code, {"error": "KIWI workflow rejected the action"})
        except URLError:
            self.send_json(502, {"error": "Could not reach the configured KIWI workflow webhook"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Hireflow running at http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
