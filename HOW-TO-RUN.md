# Contify Internal Linking Tool — How to Run

## WHY "next is not recognized" happens
The `node_modules` folder was pre-installed for Linux (inside Claude's sandbox).
Windows needs its OWN installation. You must delete the Linux `node_modules` and reinstall.

---

## Step 1 — Delete the existing node_modules

Open File Explorer → go to:
```
C:\Users\Contify ThinkBook\Desktop\Claude\contify-linking-tool\
```
Delete the entire `node_modules` folder (it may take a moment, it's large).

---

## Step 2 — Open PowerShell / Command Prompt IN that folder

Right-click inside the folder → "Open in Terminal"
OR open PowerShell and run:
```powershell
cd "C:\Users\Contify ThinkBook\Desktop\Claude\contify-linking-tool"
```

---

## Step 3 — Install dependencies (Windows version)

```powershell
npm install
```

This installs Windows-compatible binaries. Wait for it to finish (~1 minute).

---

## Step 4 — Start the app

```powershell
npm run dev
```

You should see:
```
▲ Next.js 14.x
- Local: http://localhost:3000
```

---

## Step 5 — Open the tool

Go to: **http://localhost:3000**

Paste contify.com URLs (one per line) → click **Find Linking Opportunities**

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `next is not recognized` | You skipped Step 1–3. Delete node_modules and re-run `npm install` |
| `npm is not recognized` | Install Node.js from https://nodejs.org (LTS version) |
| Port 3000 in use | Run `npm run dev -- -p 3001` and open http://localhost:3001 |
| Pages still show 0 | Check the Fetch Log section in the UI for exact error per URL |
