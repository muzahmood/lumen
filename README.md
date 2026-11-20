# Lumen

**Notes, illuminated.** Every note, diagram and drawing is a point of light, and the links between them light the way back to an idea.

Lumen is a personal notes app that runs entirely on Cloudflare's free tier: Markdown notes, Mermaid diagrams, Excalidraw drawings, images and attachments, full-text search, and version history. It works on desktop and phone (and installs as an app), keeps working offline, only opens for people Cloudflare Access lets in, and can encrypt your notes end to end so the server only ever stores ciphertext.

Everyone runs their own copy, in their own Cloudflare account: there's no shared server, and nobody else (this project included) can see your notes.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/muzahmood/lumen)

**Your own Lumen in about ten minutes, free:**

1. Click **Deploy to Cloudflare** above. Sign in to Cloudflare and GitHub, and choose a **setup password** when it asks (12 or more characters; a few random words work well).
2. Open the address it gives you. The page there walks you through putting Cloudflare Access in front of it: a few clicks (the first time, Cloudflare also has you pick a Zero Trust team name).
3. Sign in, type your setup password, and your Lumen opens.

From the command line instead: clone this repository, then `npm install` and `npm run setup`, which makes up the setup password for you. More in [Deploy your own](#deploy-your-own).

## What's in it

- **Home**: a greeting with your open-task count, a quick-capture box (a new note whose first line becomes the title, or switch it to **Journal** to add to the end of today's entry with the time), one-click new note / drawing / diagram / journal, pinned notes as cards and your recent edits.
- **Live-preview writing**: Markdown that looks finished as you type. Symbols tuck away on lines you aren't editing; checkboxes, bullets, links, images, drawings and Mermaid diagrams render in place. Select text for a formatting bubble, use the floating toolbar, or press `/` for blocks and `[[` to link notes. `Ctrl/⌘ Enter` ticks a task (or makes the line one), `Ctrl/⌘ Alt 1`–`6` makes a heading and `Ctrl/⌘ Alt 0` plain text again. Select text to see how many words it has. Callouts (`> [!tip]`), highlights (`==text==`), tables, footnotes and syntax-highlighted code. Pasting from a web page, Google Docs, Word or an email keeps headings, lists, links, tables and code as Markdown (`Ctrl/⌘ Shift V` pastes plain text).
- **LaTeX math**: `$x^2$` inline, `$$…$$` or ```` ```math ```` for display, typeset with KaTeX while you write as well as in reading view. Double-click a formula (or use a block's **Edit** button, or arrow into it) to edit its TeX with a live preview: above an inline formula, below a block. `Esc` leaves it. One click never opens a formula, so reading and scrolling past them (or scrolling a wide one sideways) leaves them as they are. `/math` inserts either kind. In note lists, inline formulas read as text (`$e^{i\pi}$` shows as "e^(iπ)", `$x^2$` as "x²").
- **Rich previews while editing**: one click on an image, drawing or diagram shows it full size, as in reading view; a double-click edits it (an image's Markdown, a drawing in the drawing editor, a diagram's code).
- **Export**: any note to PDF (a clean print layout, with paper size, title and date options, saved through the browser's Save as PDF) or Markdown (a .zip with its images and drawings as files when it has any, so links work outside Lumen). From the note's ⋯ menu or `Ctrl/⌘ K`.
- **Edit, Split or Read**: live editing, Markdown beside a rendered preview, or a clean reading view. Wide screens show an "On this page" outline that follows your scroll position.
- **Looks**: light, dark or system theme, seven accent colors, sans / serif / mono note fonts, adjustable text size and line width, resizable and collapsible sidebar and note list, and a phone layout with a bottom tab bar and sheet dialogs. On a phone, Back (the gesture or button) closes what's open first (a dialog, Settings, the drawer, search, a menu, a picture), then goes back through Lumen's pages, and only leaves Lumen from the first; opened straight at a note (a link or shortcut), Back goes Home before leaving. Every page has its own address (with the folder, tag, view or search it shows), so a link or bookmark opens it, and the tab's title says which page it is. With encryption on, tag names and searches stay out of the address, and titles only say what kind of page it is: browsers keep both in their history, and may sync it. Settings follow you to your other devices (encrypted when your notes are), except text size, pane widths, open folders and auto-lock, which are per device.
- **Diagrams**: fenced ```` ```mermaid ```` blocks render in place. A diagram editor with live preview and 12 templates (flowchart, sequence, mind map, Gantt, ER, state and more).
- **Drawings**: full Excalidraw whiteboard for sketches and freeform flowcharts. Drawings embed in notes and stay editable.
- **Images and files**: paste, drag in, or snap a photo on your phone. Large photos are shrunk before upload. Images, video and audio display inline (video and audio are sent in parts as they play, as iPhones and iPads need); other files attach as links. Files you open stay on the device for offline use, up to 200 MB (the ones opened longest ago go first). With encryption on, video and audio load when you click them, and a file link opens the decrypted file in a new tab (images, PDFs, media and text) or saves it.
- **Organising**: nested folders (drag notes onto them; a folder also lists its subfolders' notes, and a note shows its whole folder path above it), tags, pinned notes, trash with 30-day recovery. Long "Move to" menus have a box to type a folder's name into. Choose several notes (`Ctrl/⌘` click, `Shift` click for a run, or **Select notes** in the list's menu on a phone) to move, tag, pin or trash them together, or drag them onto a folder; in the trash, restore or delete them together. Rename, merge or remove a tag across every note from its menu (right-click it in the sidebar, or **Tag options** in its list), with Undo.
- **Journal**: **Today's journal** (sidebar, Home, the New menu, or the app icon's shortcut) opens today's entry, made from your journal template. Above an entry: the entries before and after it, and a calendar with every day that has one marked; pick any day to open or start it. Entries are notes titled with their date and tagged `#journal`, kept wherever the first one went (a "Journal" folder), so renaming or moving that folder doesn't start the journal over.
- **Templates**: notes in a top-level **Templates** folder. Start a note from one in the New menu or `Ctrl/⌘ K`, or put one into the note you're writing with `/template` (or `/` and its name). `{{date}}`, `{{time}}`, `{{datetime}}`, `{{weekday}}`, `{{longdate}}`, `{{year}}`, `{{month}}`, `{{day}}` and `{{title}}` are filled in, in the title too (a template titled `Meeting {{date}}` makes "Meeting 2026-11-17"). The one titled **Journal** is the journal template (`Ctrl/⌘ K` → **Edit the journal template**). Tasks in templates stay out of the Tasks view.
- **Sharing into Lumen**: once installed on a phone, Lumen shows up in the share sheet. Text, links, photos and files shared to it become a new note (the files as attachments, encrypted like any other when your notes are), once you say so: Lumen shows what came in and asks first, since any website could send something the same way. A share you leave for later is offered again next time. Long-press the app icon for **New note**, **Today's journal**, **Search** and **Tasks**.
- **Tasks**: every open task from every note in one place (sidebar, or the task count on Home): overdue, today and upcoming by due date, then the rest by note. An empty tick box (like the one in a new journal entry) becomes a task once you write something after it. Give a task a date with `due:2026-11-20` or `📅 2026-11-20` (`/due` inserts one), tick it off right there, or click it to open its note at that line. A task with a date (or one that repeats) gets the day it was ticked (`✅ 2026-11-20`); Settings → Editor can date every task, or none. A task with `🔁 every week` (or `every day`, `every 2 weeks`, `every month`, `every year`, `every weekday`, `every Monday`, `every tue and thu`, and `… when done` to count from the day it's ticked) comes back when ticked: a new one, due on its next date, goes above it, as Obsidian's Tasks plugin does.
- **Finding**: full-text search across every note (SQLite FTS5, or on your device when encrypted), narrowed with `tag:work` (or `#work`), `in:Projects` (`in:"Home stuff"`, `in:Projects/Clients`), `is:pinned`, `is:journal`, `is:template`, `has:task`, `has:done`, `has:image`, `has:drawing`, `has:diagram`, `"exact words"`, and `-` to leave something out (`-draft`, `-tag:old`); a filter on its own lists every note it matches. In a folder or tag, **Only in …** keeps the search inside it. **Save this search** (beside the list's search box) keeps it by name under **Saved searches** in the sidebar and `Ctrl/⌘ K`, up to date as notes change, on every device (encrypted when your notes are); its menu renames it, changes what it finds or deletes it. The same search works in the quick switcher on `Ctrl/⌘ K`, which also creates a note from whatever title you typed and runs commands on the open note (type `>`). Backlinks show which notes link to the one you're on, while reading or editing, and `[[Note#Heading]]` links open at that heading. Rest the pointer on a `[[link]]` in reading view to preview its note, and write `![[Note]]` (or `![[Note#Heading]]`) to show that note, or that part of it, inside this one: read-only (its tick boxes are ticked in its own note), from what's on your device (decrypted there when your notes are encrypted), and never inside itself. Rename a note and Lumen offers to update the `[[links]]` that still use its old title (outside code, with Undo). **Mentions** under a note's title lists the notes that name it without linking to it; **Link** turns a mention into a link.
- **End-to-end encryption** (optional, in Settings → Security): note text, titles, tags, folder names, version history, images, files and drawings are encrypted on your devices with a passphrase only you know, plus a recovery key. Each device is unlocked once and stays unlocked until you lock it, it locks itself after a time you choose, or you sign out. Search, backlinks and tasks then run on the device, from an encrypted copy of every note it keeps (so every note also opens offline).
- **Safety nets**: autosave, version history (a snapshot every 10 minutes of editing, 50 per note), offline edits kept on the device and synced later (the sidebar shows any notes that haven't synced, a note that needs a decision while you're elsewhere says so, and edits a closed tab never sent are taken up by the tabs still open), moving between devices without being asked about versions (see **Using more than one device** below), and a one-click backup (encrypted when your notes are, with a reminder on Home when it's been over a month). Version history shows what each snapshot would change before you restore it. Choosing **Keep mine** or **Use theirs** in a conflict, or restoring a backup over a note that has changed since, keeps the replaced text in the note's history. An upload interrupted by closing the page is taken out of its note the next time the note opens, naming the file to add again. Edits to a note that another device deleted are saved as a new note, a drawing left unsaved when the browser closed is offered back next time, and a tab left open across a deploy moves to the new version by itself, or asks first if you're in the middle of a drawing or dialog. A brand-new note you leave without typing anything is cleaned up; a note you empty keeps its history.
- **Using more than one device**: made for one person on one device at a time (writing on the computer, reading on the phone, picking up where the other left off). A device catches up with what was saved elsewhere whenever you pick it up again (the tab or window coming back, the connection returning, or the first touch after a minute), and an open note updates in place, keeping your cursor. When a device sends edits made on text that has since changed elsewhere, Lumen settles it without asking whenever it can: edits that change nothing (typed and undone) aren't sent; a save the phone sent as it locked, and never heard back about, is recognised as its own even after the computer carried on from it; edits to different lines on the two devices are combined (with a note saying so); and where they can't be combined (the same line changed on both), the later version wins and the earlier device's edits go into the note's version history, with a message offering to open it. Only text typed on a device that hadn't caught up yet, over a line changed elsewhere, asks which version to keep (**Compare** shows both versions line by line, with the changed words marked; **Keep mine**, **Keep both** or **Use theirs**). A drawing saved on another device while you had it open still asks whether to save yours as a separate drawing or replace that one.

## How it's built

| Part | Runs on | Free-tier allowance |
| --- | --- | --- |
| App (React, CodeMirror with live preview, Mermaid, Excalidraw) | Workers static assets, behind the Worker's Access check | Counts toward the Worker's requests |
| API and Access check (`worker/`, Hono) | Cloudflare Worker | 100,000 requests/day |
| Notes, folders, history, search | D1 (SQLite) | 5 GB, 5M rows read and 100k written per day |
| Images, attachments, drawings | Workers KV | 1 GB, 1,000 writes per day |
| Optional bigger file storage | R2 | 10 GB |

Everything is created in your own Cloudflare account. The database schema sets itself up on first run, so there are no migrations to apply.

Every request goes through the Worker first, including the app's own scripts, so it counts toward the 100,000 a day. A first visit uses a few dozen requests and later visits far fewer, because the app caches its files on the device. That's plenty for personal use.

Maths (KaTeX) and code colouring (highlight.js) are most of what showing a note costs to load, and most notes need neither, so they load the first time a note does, or in idle time once a note is showing. They're then kept on the device for offline use like the rest of the app.

## Run it on your computer

Needs Node.js 22.12 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173. The API runs on port 8787 with a local database and file store kept in `.wrangler/`, so nothing touches your Cloudflare account.

Cloudflare Access isn't needed locally. The `dev` and `start` scripts pass `--var LOCAL_DEV:true` to `wrangler dev`, which lets requests to `localhost` through. (They also pass `--local-upstream localhost:8787`: without it, if you add a domain to `routes` in `wrangler.jsonc`, `wrangler dev` presents local requests as if they came to that domain, and the Access check would rightly refuse them.) That flag exists only on your computer: `wrangler deploy` never sends it, and the Worker ignores it for any hostname other than `localhost`.

To try the production build locally (including offline mode): `npm run start`, then open http://localhost:8787.

## Tests

```bash
npm test             # once
npm run test:watch   # re-runs on every change
npm run test:e2e     # the whole app in Chrome (a few minutes; not part of npm test)
```

`npm test` runs two sets, both entirely on your computer (nothing touches your Cloudflare account):

- **`tests/worker/`**: the real Worker inside the Workers runtime (workerd), with a local database and file store that start empty for each test file. It covers every API route, the Cloudflare Access check (with a stand-in for Access that signs real tokens, so forged, expired and wrong-audience tokens are tested too), the cross-site write guard and security headers, conflict detection (and the save ids that let a device recognise its own saves), history (including a device's edits kept there), trash and the nightly clean-up, uploads and how they're served, drawings, and the server side of end-to-end encryption, down to checking that no plaintext is left in the search index's storage.
- **`tests/unit/`**: the app's own code against a stand-in server, in Node or jsdom (with an in-memory IndexedDB):
  - **Saving and syncing:** autosave, drafts per tab, offline edits, edits that change nothing, a phone's save that landed without a reply, combining edits from two devices (`merge.test.ts`), the later version winning with the earlier kept in history, conflicts and the answers to them, notes deleted or trashed on another device, bulk changes and tag renames with Undo, the on-device copy of every note, and how searches are routed.
  - **Encryption on the device:** turning it on, unlocking with the passphrase or recovery key, locking (by hand, automatically, after a key replacement on another device), the codec for every kind of item (ciphertext can't be moved between items or fields), the one-time conversion, replacing the key, encrypted backups, synced settings, and attachments.
  - **Writing:** the editor's commands and shortcuts, live preview, the slash menu and `[[` completion, pasting from web pages, Google Docs, Word, Outlook and email, and word counts.
  - **Reading view:** every Markdown feature the app supports, rendered and sanitised against script injection, fake controls, remote loads under "Ask first" and attachments fetched around encryption.
  - **Features:** tasks and due dates, the journal and templates, search filters, mentions, renaming links, sharing into Lumen, note-list previews and maths as text, with timing guards against input that would make any of them slow.
  - **Screens** (`ui-*.test.tsx`): every component rendered in jsdom, from the sidebar, note list, Home, search and Tasks to the note view, its conflict choices, history, export, settings, the encryption screens and every dialog and menu, including keyboard use and what screen readers are told.

`npm run test:e2e` drives the built app in your installed Google Chrome (Playwright, `tests/e2e/`): it starts `wrangler dev` with an empty database on a free port from 8796 to 8799, runs every journey (first use, encryption and unlocking, a second device and its conflicts, a phone picking up after the computer, working offline (edits combined, or the later one kept), backups, tasks and the journal, sharing into Lumen, the phone layout, links and settings, drawings, replacing the key), fails on any unexpected error in the page, then stops the server. Needs Chrome; nothing is downloaded.

`npm run build` checks the TypeScript types first, so a type error stops a deploy. To have a failing test stop it too, make your Workers Builds build command `npm test && npm run build` (see [Deploy your own](#deploy-your-own)). Run `npm test` before you push to find out sooner.

## Deploy your own

Each copy of Lumen is one Worker in your own Cloudflare account, with its own database (D1) and file store (KV), on the free plan. Nothing in this repository is tied to an account: the first deploy creates the storage (named after the Worker: `lumen-db` and `lumen-files-kv`), and what belongs to your copy (which Access application to trust, who may sign in) is recorded by your Lumen when you set it up, or kept in your Worker's settings on Cloudflare, never in the code. Until it's set up, every address shows the setup page and serves nothing else, not even the app itself: a fresh deploy is never publicly readable.

There are three ways in. All three end on the setup page, which walks you through [Cloudflare Access](#protect-it-with-cloudflare-access).

### 1. The Deploy to Cloudflare button (quickest)

1. Click **Deploy to Cloudflare** at the top of this page, and sign in to Cloudflare (or create a free account).
2. Connect your GitHub (or GitLab) account and check the names it offers: the repository it makes for your copy, the Worker (its address becomes `https://<name>.<your-subdomain>.workers.dev`), and the database and file store. The defaults are fine. Choose a **setup password** (`SETUP_PASSWORD`): 12 or more characters, typed once on your Lumen's first page.
3. Deploy. Cloudflare copies this repository into your account, creates the storage, builds Lumen and deploys it, in a couple of minutes.
4. Open the Worker's address and follow the setup page.

Your copy is connected to Workers Builds, so every push to its `main` branch deploys it again. Build logs are under **Workers & Pages → (your Worker) → Deployments**.

### 2. Fork, then connect (easiest to keep up to date)

1. **Fork** this repository on GitHub.
2. In the Cloudflare dashboard, open **Workers & Pages → Create → Import a repository**, pick your fork, and use the settings below. The first build creates the storage and deploys.
3. In the Worker's **Settings → Variables and Secrets**, add a **Secret** named `SETUP_PASSWORD`: 12 or more characters.
4. Open the Worker's address and follow its setup page.

Later versions are then one click away: **Sync fork** on GitHub, and Workers Builds deploys the update.

| Workers Builds setting | Value |
| --- | --- |
| Build command | `npm run build` (or `npm test && npm run build`, so a failing test stops the deploy) |
| Deploy command | `npx wrangler deploy` (add `--domain notes.example.com` for [your own domain](#your-own-domain)) |
| Root directory | `/` |

If you name the Worker something other than `lumen`, Workers Builds deploys it under your name anyway, and may open a pull request that changes `name` in `wrangler.jsonc` to match (merging it is fine). The Node version comes from `.node-version` (24, the current long-term release; locally anything from 22.12 works). Builds of other branches upload a version without making it live, and preview URLs are off, so a branch never serves anything.

### 3. From your computer

Needs Node.js 22.12 or newer and Git.

```bash
git clone https://github.com/muzahmood/lumen.git
cd lumen
npm install
npm run setup
```

`npm run setup` signs you in to Cloudflare (in your browser), asks what to call the Worker, and builds and deploys it (the first deploy creates the storage) with a setup password it makes up: four random words, shown when it's done. It then opens the Cloudflare dashboard for the Access step and sends you to the setup page. It's safe to run again. After that, `npm run deploy` deploys whatever is in the folder. (Without the script: `npx wrangler login`, `npm run deploy`, `npx wrangler secret put SETUP_PASSWORD`, then the setup page.)

If your Cloudflare login has more than one account, Wrangler asks which to use; to skip the question, put `CLOUDFLARE_ACCOUNT_ID=<id>` in a `.env` file in the folder (Git ignores it).

### Updating

New versions arrive in this repository. The database schema updates itself on the first request after a deploy, so there's never a migration to run, and your notes, files and Access settings stay as they are.

- **Fork:** **Sync fork** on GitHub. Workers Builds deploys it.
- **From your computer:** `git pull`, `npm install`, `npm run deploy`.
- **A copy made with the button** is a repository of its own, not a fork. Bring this one's changes into it, then push (Workers Builds deploys it):

  ```bash
  git remote add upstream https://github.com/muzahmood/lumen.git   # once
  git fetch upstream
  git merge upstream/main --allow-unrelated-histories
  git push
  ```

  `--allow-unrelated-histories` is needed only if the deploy screen started your copy with a history of its own; it changes nothing otherwise. If Git reports conflicts, take this repository's version of each file (`git checkout --theirs <file>`), except in `wrangler.jsonc`, where you keep your own Worker `name` and any resource names or IDs the deploy screen wrote there. Then `git add -A` and `git commit`.

### Your own domain

1. In the Worker's **Settings → Domains & Routes**, add a custom domain such as `notes.example.com` (the domain must be on Cloudflare). Or, to keep the domain with the deploy, deploy with `npx wrangler deploy --domain notes.example.com` (as the Workers Builds deploy command, or `npm run build && npx wrangler deploy --domain notes.example.com` from your computer). That also turns the `workers.dev` address off, so there's no second address to protect.
2. If you protected the whole Worker (**All traffic** in its **Access** tab), the domain is already covered, and nothing else changes. Otherwise, in **Zero Trust → Access → Applications**, add a **Self-hosted** application for that hostname with an **Allow** policy for your email.
3. If that created a second Access application, Lumen has to trust it too: set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (both Audience tags, separated by a comma) as variables (see [Setting it up by hand](#setting-it-up-by-hand)).

A domain added only in the dashboard leaves the `workers.dev` address on (each deploy turns it back on). That's safe, because the Worker refuses any request Access didn't sign in, but it's a second address to keep protected; `--domain` avoids it.

## Protect it with Cloudflare Access

Cloudflare Access is Cloudflare's sign-in gate, part of Zero Trust (free for up to 50 people). Lumen relies on two layers. Cloudflare Access signs you in at the edge. Then, on every request, the Worker checks the signed Access token itself: the signature, your team, this app's ID, and the expiry date. A request that reaches the Worker any other way gets nothing, whether through a hostname you forgot to protect or with a forged token.

The setup page shows these steps and marks the one you're on:

1. **Zero Trust, the first time.** If you've never used Cloudflare Access, the dashboard first asks you to set up **Zero Trust**: a team name and the **Free** plan. It may ask for a payment card; the Free plan isn't charged.
2. **Turn on Access for your Worker.** Open **Workers & Pages → (your Worker) → Access**, choose **Protect this Worker behind Access** → **All traffic**, pick a policy that lets in only you (**Cloudflare account** does, if you're its only member) and **Apply**. That covers every address the Worker has, including a custom domain added later.
3. **Claim it.** Open your Lumen's address and sign in. Type your setup password (the one you chose on the Deploy screen, or that `npm run setup` showed you) and choose **Finish setup**. Lumen records which Access application to trust and lets in only the account you signed in with. Your notes open.

**Why a setup password.** A new Lumen is reachable before Access is in front of it, and anyone can get a validly signed Access sign-in from a Zero Trust team of their own, so a sign-in alone doesn't show the Lumen is yours: the password does. It must be 12 or more characters, wrong ones are limited to 10 an hour, and once your Lumen is set up the form is gone and the password is never used again. No setup password yet (or forgotten)? Add or replace the `SETUP_PASSWORD` secret in **Settings → Variables and Secrets**, and reload.

### Setting it up by hand

Variables do the same job, and win over what the setup page recorded: `ACCESS_TEAM_DOMAIN` (`https://<team>.cloudflareaccess.com`), `ACCESS_AUD` (the Access application's Audience tag; several separated by commas) and, optionally, `ACCESS_ALLOWED_EMAILS`. Signed in, the setup page lists the exact values (under **No setup password?**); you can also find them in the dashboard: the team domain under **Zero Trust → Settings**, and the AUD tag on the Access application's overview. Add them in **Settings → Variables and Secrets** (type **Text** or **Secret**) and deploy, or from the command line with `npx wrangler secret put ACCESS_AUD` (and so on). `"keep_vars": true` in `wrangler.jsonc` stops a deploy from removing variables set in the dashboard. A `vars` section in `wrangler.jsonc` works too, and wins over the dashboard on every deploy.

**Who gets in.** The setup page lets in only the account that claimed it. To change that, set `ACCESS_ALLOWED_EMAILS` to a comma-separated list (for example `me@example.com,partner@example.com`, yourself included), and let them through the Access policy too. The Worker refuses any account that isn't on the list, even one the Access policy lets in by mistake.

**Starting setup over.** If you delete and recreate the Access application, sign-ins stop being verified (it has a new Audience tag). Either set the variables above, or forget what the setup page recorded and claim it again: in the dashboard, **Storage & Databases → D1 → (your database) → Console**, run `DELETE FROM kb_meta WHERE key = 'access_config';` (or `npx wrangler d1 execute <database> --remote --command "DELETE FROM kb_meta WHERE key = 'access_config'"`), and within a minute the setup page is back.

### Signing out, and what else protects your notes

**Settings → Security** in the app shows who you're signed in as. **Sign out of this device** removes the notes, files and drawings the browser keeps for offline use (including its HTTP cache and the encrypted copy of every note), signs out every other Lumen tab in that browser too, then ends your Access session. Use it on any computer that isn't yours. Offline, it can't empty the browser's cache of opened pictures and files, so it says so before leaving (clear the site's data in the browser's settings), and empties it the next time Lumen opens there.

**What else protects your notes:**
- A strict Content Security Policy: scripts only from the app itself, and no framing by other sites.
- Uploaded files are served with a known-safe type, or as a download, and can't run script when opened.
- HTML written in a note (or a diagram) is cleaned before it's shown: it can't run script, imitate Lumen's own buttons and tick boxes, or cover the app.
- Write requests must carry a header that other websites can't add.
- Note data is never stored in shared caches.
- Drawing fonts are served by the app itself, so nothing is loaded from third-party servers.

## End-to-end encryption

Turn it on in **Settings → Security → Set up encryption**. You choose a passphrase and save a recovery key, then Lumen encrypts every note, image, file and drawing already saved (with a progress screen; it picks up where it left off if interrupted). From then on:

- **What's encrypted**: note text, titles, tags, the previews shown in lists, folder names and version history, using AES-256-GCM in the browser (Web Crypto). Each piece is tied to its note and field, so encrypted text can't be moved between notes. Images, files and drawings are encrypted too, each under a random key of its own (a drawing's under a new one each time it's saved), tied to its id; that key, with a file's name and type, is stored wrapped by your main key. Your devices decrypt them to show them, and only ask the server for a file by its id, so no request carries its name.
- **What the server sees**: ciphertext, plus what it needs to sync: note, folder, file and drawing ids, which folder a note is in, pinned and trash state, dates and sizes. The full-text search index is emptied (each note's words are erased from it as soon as that note is encrypted, and the server empties it completely once nothing is left in plaintext), and the server refuses to store unencrypted note text, files or drawings.
- **Keys**: one random key encrypts everything. It's stored only wrapped (encrypted) by your passphrase (PBKDF2-SHA256, 600,000 rounds) and by your recovery key. Neither secret leaves your devices. The wrapped key is on the server (and in backups and each device's storage), so anyone with a copy could try passphrases offline: choosing one shows how long that would take on a fast graphics card (estimated with zxcvbn), refuses one that would take under about two years, and offers six random words from the EFF's diceware list (CC BY 3.0 US) instead.
- **Each device**: unlock once with your passphrase. The key then stays in that browser as a non-extractable key (scripts can use it, but can't read it out) until you **Lock now**, it locks itself after the time you set under **Lock automatically**, or you sign out. While locked, unsent edits and other text Lumen keeps in the browser are encrypted too. Locking one tab locks every Lumen tab in that browser.
- **Forgot the passphrase?** Choose **Forgot your passphrase?** on the unlock screen, enter the recovery key, and set a new passphrase. Changing the passphrase or making a new recovery key means Lumen stops accepting the old one. The old one still opens copies of your encryption settings from before the change: on a device that hasn’t been online since (until it next connects), and in D1 Time Travel restore points (7 days on Free, 30 on Paid). Both hold the same underlying key, so replacing a passphrase or recovery key doesn’t lock out someone who already has the old one and such a copy: for that, replace the key (next). **If you lose both, nobody can recover your notes.**
- **Replacing the key** (**Settings → Security → Encryption key → Replace key**): if a passphrase or recovery key may have been seen. Lumen makes a new key and a new recovery key (your passphrase stays), then encrypts everything again on that device (for images, files and drawings, only their own keys are wrapped again, so nothing is uploaded twice), with a progress screen; it picks up where it left off if interrupted. Old passphrases, recovery keys and copies of your encryption settings then open no note, title, tag, folder name or saved version, and no image, file or drawing added from then on. An image, file or drawing from before keeps its bytes, so someone with the old key and an older copy of its wrapped key (a device that had opened it, or a D1 Time Travel restore point) could still open that one: if that matters, delete it and add it again. Other devices notice the next time they save or open a note, lock, and ask for the passphrase once; edits they hadn’t sent yet are kept, encrypted, and sent with the new key. Earlier keys stay in your encryption settings, encrypted with the new key, so text from before the replacement still opens.
- **Unencrypted items are refused**: once a device has seen your whole library encrypted, it remembers that until you sign out of it. Lumen never saves unencrypted text after that, so a note, folder or version that reaches the device unencrypted was put on the server some other way. The device lists it as **Unencrypted note** (or folder, or version) without showing any of it, won't open or restore it, and never encrypts it as one of yours; you can move it to the trash. The same goes for images, files and drawings once the device has seen them all encrypted: one that arrives unencrypted isn't shown. Each device also checks that the server sends the note or version it asked for, not another one.
- **Search, backlinks and tasks** run on the device. Each device keeps a copy of every note in the browser (IndexedDB), as the server sends it: ciphertext, decrypted only in memory while unlocked. It's kept in step in the background, fetching only notes whose version changed, so search is instant, the Tasks view and link updates have every note's text, and any note opens offline. Signing out of the device deletes the copy. Each note's encrypted preview also lists the notes it links to (links written inside code don't count), so backlinks come from the note list. Previews made by an earlier version of Lumen are remade from the copy on the device, in the background, once it's up to date.

What it doesn't protect against:

- **Whoever can change the app.** The app comes from your Worker, so someone who can deploy to it (through your Cloudflare or GitHub account) could serve a version that captures your passphrase. Keep both accounts behind two-step sign-in.
- **Older copies.** D1 Time Travel keeps restore points for 30 days on Workers Paid (7 on Free), so copies from before encryption was turned on last that long. A **Readable .zip** backup isn't encrypted (the standard backup is).
- **An unlocked device.** Anyone using a device you left unlocked can read your notes there. Set **Lock automatically** on devices you share or carry.
- **Images from other websites.** A note showing an image from another site tells that site your IP address and when you opened the note. Set **Settings → Security → Images from other websites** to **Ask first** to load them only when you click. Turning on encryption sets it to **Ask first** for you.

## More file storage with R2 (optional)

KV gives you 1 GB with no payment method on file. R2 gives 10 GB free and larger uploads (95 MB instead of 25 MB), but you have to enable R2 on your account first.

1. Enable R2 in the dashboard (**R2 Object Storage**).
2. Uncomment the `r2_buckets` block in `wrangler.jsonc`.
3. Deploy: `npm run deploy`, or commit and push if your copy deploys from GitHub. The bucket is created automatically.

New uploads go to R2. Files already in KV keep working, so leave the KV binding in place.

The same block has `BACKUP_BUCKET`, a bucket of its own for automatic weekly backups (see **Backups**). Uncomment just that one to turn them on without moving uploads to R2.

## Backups

- **In the app**: Settings → Data → **Download backup**. It holds every note as a Markdown file (with front matter, in folders), every image and drawing, and a `kb-backup.json` that **Restore a backup** reads back in. Home reminds you when there's never been one or the last was over a month ago (on any device; **Later** puts it off for a week).
  - **With end-to-end encryption on** it's an encrypted `.lumenbackup` file: the .zip encrypted on your device under a key of its own, that key encrypted with your library key, plus your encryption settings as they were. It opens with the passphrase or recovery key you had when you made it, in any Lumen, even a brand-new one; a device still unlocked with that key opens it without asking. Only Lumen can open it.
  - **Readable .zip** (next to it) gives the same backup unencrypted, for opening in other Markdown apps. Anyone who gets that file can read it.
  - Restoring into an encrypted library encrypts everything again as it goes in.
  - Restoring puts the notes back first, then files and drawings. Files still in the library aren't uploaded again, and a drawing changed since the backup is kept as it is (drawings have no history to fall back on). Anything that couldn't be restored is listed. If the connection drops or a daily limit runs out, the restore stops and says how far it got; restoring the same backup again finishes it.
  - A note this device can't decrypt (encrypted with a different key, or changed outside Lumen) doesn't stop the backup: it's made without that note, and you're told which notes were left out. Files that couldn't be downloaded are listed the same way.
- **Automatic, on your Cloudflare account** (optional): once an R2 bucket is set up for them (`BACKUP_BUCKET`, see **More file storage with R2**), about once a week whichever device has Lumen open and unlocked makes the same backup as **Download backup** (encrypted on it when your notes are, so the bucket holds only ciphertext) and keeps it there; the newest eight are kept. Settings → Data lists them, with **Restore** (the usual restore), **Download**, **Back up now**, and a switch to turn them off. A library over 95 MB is too big to keep this way: download its backups instead.
- **D1 Time Travel**: Cloudflare can restore the database to an earlier minute. See `npx wrangler d1 time-travel --help` and Cloudflare's D1 docs for how far back your plan goes. It covers note text only; files live in KV/R2.
- `wrangler d1 export` does not work on this database because the full-text search index is a virtual table. Use the in-app backup instead.

## Keyboard shortcuts

| Keys | Does |
| --- | --- |
| `Ctrl/⌘ K` | Search notes and run commands |
| `Ctrl/⌘ Enter` (in search) | New note with the title you typed |
| `Alt N` | New note |
| `↑` `↓` (in the note list) | Move between notes; `Enter` opens one |
| `Ctrl/⌘ click`, `Shift click` (in the note list) | Choose several notes; `Ctrl/⌘ A` chooses all, `Esc` lets them go |
| `→` `←` (on a sidebar folder) | Open or close its subfolders |
| `Ctrl/⌘ E` | Switch between reading and editing |
| `Ctrl/⌘ S` | Save now |
| `Ctrl/⌘ \` | Show or hide the sidebar |
| `Ctrl/⌘ ,` | Settings |
| `Ctrl/⌘ click` | Open a link while editing |
| `Ctrl/⌘ B`, `Ctrl/⌘ I` | Bold, italic |
| `Ctrl/⌘ Shift H` | Highlight |
| `Ctrl/⌘ Shift K` | Insert link |
| `Ctrl/⌘ Shift V` | Paste as plain text (a normal paste turns formatting into Markdown) |
| `Ctrl/⌘ Enter` (while editing) | Tick a task, or make the line one |
| `Ctrl/⌘ Alt 1`–`6`, `Ctrl/⌘ Alt 0` | Heading 1 to 6, plain text again |
| `Ctrl/⌘ F` | Find in the note |
| `/` at the start of a line | Insert menu |
| `[[` | Link to another note |

## Brand

The palette is called Prussian Ink: the deep blue of cyanotype prints and fountain-pen ink, lit by marigold. The logo is a bayaz: an open notebook with a ribbon marking your place.

| Name | Hex | Used for |
| --- | --- | --- |
| Lapis | `#22346E` | The logo tile and avatar |
| Ink blue | `#1E4E80` (dark mode `#7EB0E6`) | Buttons, links, selection; the default accent |
| Marigold | `#EBA53A` (icons `#B7760C`, dark mode `#F0B550`) | The only warm color in the app: pinned notes, highlights |
| Rubric | `#B3261E` | The logo's ribbon only |
| Ink | `#142030` | Text, a blue-black |
| Paper | `#F1F4F8` | Light surfaces |
| Midnight | `#0B1119` | Dark surfaces |

The logo is an open notebook on a lapis tile: a cream left page, a slightly shaded right page, a faint fold between them, and a red ribbon hanging from the top of the right page to mark your place. In Urdu and Persian, a *bayaz* (بیاض) is the personal notebook in which readers copied the lines worth keeping, which is what Lumen is for. The name is set in Literata. Source: `public/icon.svg` (the same drawing is in `BrandMark` in `src/components/Sidebar.tsx` and in `worker/gate.ts`); the PNG app icons are generated with `node scripts/make-icons.mjs`. The accent can be changed in Settings → Appearance; the logo keeps its brand colors.

## Project layout

```
worker/            Cloudflare Worker (Access check + API)
  gate.ts          the Access check every request passes, security headers, setup page
  setup.ts         which Access app to trust: the variables, or what the setup page recorded
  index.ts         routes: notes, folders, search, files, drawings, export, encryption keyring
  auth.ts          Cloudflare Access token (JWT) verification
  schema.ts        D1 schema, applied automatically
  storage.ts       KV / R2 file storage
src/               React app
  components/      home, sidebar, note list, note view, editor, preview, dialogs, drawing editor
  lib/             API client, autosave, Markdown rendering, live preview, Mermaid, backups;
                   crypto.ts, vault.ts and e2ee.ts for end-to-end encryption
shared/            note text helpers used by both the Worker and the app
tests/             worker/ (API in the Workers runtime) and unit/; see "Tests"
  styles/          app and reading styles
public/            icons, web app manifest, service worker (offline support)
scripts/           setup.mjs (npm run setup: a guided first deploy), make-icons.mjs
wrangler.jsonc     Cloudflare configuration (nothing account-specific; see "Deploy your own")
```

## Troubleshooting

- **"Finish setting up your Lumen"**: it isn't set up yet. Follow the steps on the page (see [Protect it with Cloudflare Access](#protect-it-with-cloudflare-access)).
- **"That isn't the setup password"**: a secret can't be read back, so replace `SETUP_PASSWORD` in **Settings → Variables and Secrets** with one you know (12 or more characters), and type that. **"Too many wrong setup passwords"**: 10 wrong ones close the form for an hour; wait, or [set it up by hand](#setting-it-up-by-hand).
- **"Lumen can't read its settings just now"**: the database didn't answer. Reload in a moment.
- **The setup page came back after a deploy**: something in the repository replaced the values you set in the dashboard. Usually it's a `vars` section in `wrangler.jsonc` (which wins over the dashboard) that leaves them out or empty, or `"keep_vars": true` was removed. Remove the section or put the values in it, and deploy again.
- **"This address isn't protected by Cloudflare Access"**: Access isn't in front of the hostname you opened. Turn it on for that hostname, or for the whole Worker.
- **"Your sign-in couldn't be verified"**: the Access token didn't match. Usually the Access application was recreated, so it has a new Audience tag: see [Starting setup over](#setting-it-up-by-hand) (or, with variables, add the new tag to `ACCESS_AUD`). Reloading signs you in again if the session simply expired.
- **"This account can't open these notes"**: you're signed in with an account that isn't allowed in: not the one that claimed this Lumen, or not in `ACCESS_ALLOWED_EMAILS`. See [Who gets in](#setting-it-up-by-hand).
- **"Your sign-in session has ended"**: your Access session expired. Choose **Sign in again**; edits you made are kept on the device and saved after you sign back in.
- **"Lumen has used up today's Cloudflare free allowance"**: one of the free plan's daily limits ran out (100,000 requests, D1's rows read or written, or KV's 1,000 writes). Edits stay on the device and are sent once the limits reset at midnight UTC; nothing is retried before then. Moving file storage to R2 (see above) or Workers Paid raises the limits.
- **"Your notes are end-to-end encrypted, and this copy of Lumen is out of date"**: a tab opened before an update tried to save unencrypted text. Reload it; its unsent edits are kept and saved encrypted.
- **An "Unencrypted note" or "Unencrypted folder" appears**: something on the server was stored unencrypted after your library was encrypted, which Lumen itself never does (see End-to-end encryption). Move it to the trash. If you restored the database to a point before you turned encryption on, open Lumen on a device you've used since (it puts your encryption settings back on the server), then sign out of that device and unlock it again: it then encrypts those notes as yours.
- **"That passphrase didn't unlock your notes"** after changing it on another device: use the new passphrase. Old ones stop working once replaced.
- **Uploads fail with "No file storage is set up"**: the `FILES_KV` binding is missing from `wrangler.jsonc`.
- **A deploy fails with "binding name already in use"** (or similar): the same setting, say `ACCESS_AUD`, is set twice, as a variable and as a secret (or in `wrangler.jsonc` and as a secret). Keep one: delete the other in **Settings → Variables and Secrets**.
- **Edited code but the local server shows old assets**: `wrangler dev` doesn't notice a rebuilt `dist/` folder. Stop it and run `npm run start` again.

## License

Lumen is released under the [MIT License](LICENSE). The pieces it bundles keep their own licenses: its npm dependencies (MIT, ISC, BSD-3-Clause, and MPL-2.0 or Apache-2.0 for DOMPurify), the Geist and Literata fonts and the wordmark cut from Literata ([SIL Open Font License 1.1](src/fonts/OFL.txt)), and the EFF's diceware word list behind suggested passphrases, which comes with zxcvbn-ts (CC BY 3.0 US).
