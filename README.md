# Hireflow

Responsive recruiting dashboard with persistent candidate intake, personalized Sarvam powered first-round interviews, structured role scorecards, a recruiter review and feedback screen, candidate stage tracking, and a KIWI workflow webhook bridge. Candidate records are stored locally in the ignored `hireflow.db` SQLite file.

## Run locally

The project already has an ignored `.env` file containing `SARVAM_API_KEY`. Start the app with:

```sh
python3 server.py
```

Then open http://127.0.0.1:8000. The interview uses `sarvam-105b-conversations` for interview turns and recommendations, Saaras v4 for candidate audio transcription, and Bulbul v4 Flash for spoken prompts. Candidates tap “Record answer” to record up to 25 seconds, then stop to send their answer and hear the next question. The agent confirms the candidate's preferred name, asks about qualifications, relevant experience, and optional interests, then asks questions tailored to the selected role and profile. Interests are excluded from hiring evaluation. Product Designer, Frontend Engineer, Product Manager, and ML Engineer each have a role-specific competency rubric. After an interview, open the candidate's Review screen to see competency scores with evidence, strengths, gaps, follow-up questions, the transcript, recruiter notes, and a human-selected outcome.

## Deploy to Vercel

Import `arjune4dev/sarvam-interview` in Vercel and set `SARVAM_API_KEY` in the project's Production environment variables before deploying. Add `KIWI_WORKFLOW_WEBHOOK_URL` to enable KIWI actions. The Vercel adapter stores SQLite under `/tmp`, so candidate and interview data is temporary; connect a persistent database before using it with real recruiting records.

## KIWI workflow

Create a KIWI workflow for candidate intake, scheduling, outreach, or application status and enable its webhook. Add the webhook URL to `.env` as `KIWI_WORKFLOW_WEBHOOK_URL=`. If your webhook expects a bearer token, set `KIWI_WEBHOOK_TOKEN=` too. Hireflow sends an action, candidate data, details, and `requires_approval: true`; configure the KIWI workflow to prepare the requested work and keep external changes behind KIWI's approval step.

The app does not store candidate records yet. Interview transcript and generated scorecard stay in the browser session. The scorecard is recruiter decision support; a person makes the hiring decision.
