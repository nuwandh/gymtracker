# Gym Tracker

A phone-first web app for your A/B gym plan. It shows the next workout, runs the rest timer, logs every set to a Google Sheet, suggests weights from your history, and charts your progress. Hosted on Vercel, works offline in the gym.

## How it works

- **Frontend:** plain HTML/CSS/JS in `public/`, no build step. Installable on your phone's home screen.
- **Backend:** two tiny Vercel functions in `api/` (`GET /api/data`, `POST /api/session`).
- **Storage:** your own Google Sheet with two tabs, `Sessions` and `Sets`. The app creates them and writes the header rows on first use.
- **Next workout:** always the one you did *not* do last. Missed days never break the order.
- **Offline:** finished workouts are saved on the phone first and upload when you have signal. Nothing is lost if the gym Wi-Fi is bad.
- **Plan:** edit `public/plan.js` to change exercises, sets, reps or rest times. After a deploy, bump `VERSION` in `public/sw.js` so phones drop the old cached copy.

## Setup (about 15 minutes)

### 1. Create the Google Sheet
1. Create a new empty Google Sheet (name it anything, e.g. "Gym Tracker").
2. Copy its ID from the URL: `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

### 2. Create a service account (the app's login to your sheet)
1. Go to <https://console.cloud.google.com/> and create a project.
2. Enable the **Google Sheets API** for that project (APIs & Services, Library).
3. IAM & Admin, Service Accounts, **Create service account** (any name, skip the optional steps).
4. Open the new account, **Keys**, Add key, Create new key, **JSON**. A file downloads. Keep it private.
5. Open the JSON and copy the `client_email` value.
6. In your Google Sheet, click **Share** and add that email as **Editor**.

### 3. Deploy to Vercel
1. Put this folder in a GitHub repo and import it at <https://vercel.com/new> (framework preset: **Other**), or run `npx vercel` from this folder.
2. Add these **Environment Variables** (Project Settings, Environment Variables):

| Name | Value |
|---|---|
| `APP_PASSWORD` | A long passphrase you choose. This is the key you type on your phone. |
| `SHEET_ID` | The ID from step 1. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The whole contents of the JSON key file. (Base64 of the file also works.) |

3. Deploy (or redeploy after adding the variables).

### 4. Use it on your phone
1. Open your Vercel URL, enter the `APP_PASSWORD` once.
2. iPhone: Share, **Add to Home Screen**. Android: browser menu, **Install app**.
3. Open it once with signal so the offline copy is saved.

## Security notes

- Anyone can open the URL, but every API call needs your `APP_PASSWORD`. Make it long (a few random words).
- Never commit the service-account JSON or `.env`. They are in `.gitignore`.
- To change the key: change `APP_PASSWORD` on Vercel, redeploy, then enter the new key in the app's Settings.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000, key: dev-password, data kept in memory only
npm test         # logic, storage, API and end-to-end UI tests
```

## Good to know

- **Week number** counts from the date of your first logged workout. Weeks 1-2 use 2 sets for the newer exercises, week 6-8 shows the barbell-bench check reminder, and every 7th week shows a deload reminder.
- **Weight suggestions** follow your rules: every set at the top of the rep range means add the smallest jump; stuck on the same weight for 3 sessions means drop about 10%. The app can't know your reps in reserve, so the "if you had 1-2 reps left" check is on you.
- **Pain flag:** tick "Felt pain or pinching here" on any exercise. It is saved to the sheet and shown as a warning next time.
- **Rest alerts:** the beep and vibration need the screen on (the app keeps it awake during a workout where the phone allows it). iPhones do not vibrate from web apps.
- Your sheet is yours: you can open it, chart it, or export it any time.
