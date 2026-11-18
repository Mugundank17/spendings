# Spendings

A simple app for your phone that tracks how much you spend. It's built as a Progressive Web App: no app store, it works offline, and your data stays on your phone.

## Features
- Add an expense in a few taps (amount, category, note, date). Tap an expense to edit or delete it.
- Monthly total, today's spend, daily average
- Monthly budget with a progress bar and a "you can spend X per day" figure for the rest of the month
- Breakdown by category
- Browse past months
- Export to CSV (for Excel or Sheets), plus a JSON backup and restore
- **Import bank or credit-card statements** (Excel `.xlsx`/`.xls`, `.csv`, or **PDF**):
  - finds the date, description and amount columns on its own (you can change them if it guesses wrong)
  - works out debits and credits from Dr/Cr marks, separate withdrawal/deposit columns, or the running balance, and skips credits (salary, refunds) by default
  - turns UPI/POS text like `UPI/DR/4123…/SWIGGY/…` into a readable name ("SWIGGY") and picks a category (Swiggy → Food, Uber → Transport, …)
  - flags rows that are already in the app so you don't add them twice
  - asks for the password if the PDF is password-protected
  - you check everything before it's added, and the file is read on your phone without being uploaded
  - scanned (image-only) PDFs can't be read; download the Excel/CSV version from your bank instead

## Put it on your phone
1. Host it for free on GitHub Pages: merge this into `main`, then go to **Settings → Pages → Source: GitHub Actions**.
   The included workflow publishes it at `https://<your-username>.github.io/spendings/`.
2. Open that link on your phone:
   - **Android (Chrome):** menu ⋮ → **Add to Home screen / Install app**
   - **iPhone (Safari):** Share → **Add to Home Screen**
3. Open it from the home screen icon. It runs full screen and works offline.

## Your data
Expenses are saved only on your device (in browser storage), so there's no account and no server.
Tap **Backup** now and then and keep the file somewhere safe. If you clear browser data or switch phones, use **Restore**.

## Run locally
```bash
python3 -m http.server 8000
```
Then open http://localhost:8000.
