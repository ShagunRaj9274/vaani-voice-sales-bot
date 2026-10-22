# Vaani – AI Voice Sales Bot

A website where an AI sales agent holds a real voice call about a SaaS product. The customer talks, the bot answers and tries to close, the chat shows both sides live, the call is recorded, and when it ends the app writes a summary and assigns a sales status.

## What it covers

| Requirement | How it works |
|---|---|
| Voice conversation | Browser speech recognition hears the customer, Claude writes the reply, browser speech synthesis speaks it. The bot opens the call, asks discovery questions, pitches, handles objections and asks for a demo or sign-up. |
| Language | English, Hindi and Telugu (dropdown). The bot, recognition and voice all switch together. |
| Live chat screen | Both sides appear as chat bubbles while talking, including grey interim text as the customer speaks. Typing a reply is also possible. |
| Call controls | Start call, End call, running timer, status line (Connecting, Bot is thinking, Bot is speaking, Listening, Analysing) and a live microphone level meter. |
| Recording and consent | A consent checkbox must be ticked before Start call works. The bot also announces that the call is recorded. The recording is saved after the call, with a player and a download link. |
| AI summary | Summary, customer requirements, objections and next steps, written by Claude from the transcript. |
| Sales status | Converted, Interested, Follow-up Required, Not Interested, Demo Requested or No Response, with a one-line reason. If the customer never speaks, the status is No Response. After two silent gaps of 15 seconds the bot says goodbye and ends the call. |
| Call history | Every call is stored with its recording, summary, transcript, duration and status. Open, play or delete any of them from the Call history tab. |

## Run it on your computer

Requires Node 18 or newer and an Anthropic API key (create one in the Anthropic Console, see https://docs.claude.com).

```bash
cd vaani
export ANTHROPIC_API_KEY=your-key-here      # Windows PowerShell: $env:ANTHROPIC_API_KEY="your-key-here"
node server.js
```

Open http://localhost:3000 in **Chrome or Edge** and allow the microphone. There is nothing to install: the server has no npm dependencies.

## Get the working website link

The microphone only works on HTTPS (or localhost), so deploy to a host that gives you an HTTPS address. Render works well and has a free tier:

1. Put the `vaani` folder in a new GitHub repository.
2. On render.com choose New, then Web Service, and connect the repository.
3. Runtime: Node. Build command: leave empty. Start command: `node server.js`.
4. Under Environment add `ANTHROPIC_API_KEY` with your key.
5. Deploy. Render gives you an `https://….onrender.com` link. Submit that link.

Railway, Fly.io or any Node host works the same way. On Render's free tier the first request after idle takes about a minute to wake up, so open the link once before you record the video or present.

Your key stays on the server. The server also limits each visitor to 150 requests per 10 minutes so a public link cannot run up a large bill. Change it with `RATE_LIMIT_PER_10_MIN`.

## How it works (for the video)

```
Customer's voice ──► Chrome speech recognition ──► text
                                                    │
                                    POST /api/chat  ▼
                           Node server ──► Claude (sales prompt + product facts)
                                                    │
                                   reply text ◄─────┘
                                                    ▼
                          chat screen + browser text-to-speech ──► speaker
        (mic is recorded the whole time with MediaRecorder)

End call ──► POST /api/analyze ──► Claude returns summary, requirements,
             objections, next steps and one of six statuses
          ──► call, transcript, analysis and recording saved in the browser (IndexedDB)
```

Files:
- `server.js` serves the site and exposes `/api/chat` and `/api/analyze`. It holds the sales prompt, the analysis prompt and the status rules.
- `public/app.js` runs the call loop, recording, history and rendering.
- `public/index.html` and `public/styles.css` are the interface (light and dark themes).

## Two-minute demo video script

1. **0:00** Show the site. Say: "This is Vaani, an AI voice sales bot. It can sell any SaaS product. I'll sell FlowDesk, a demo helpdesk product, and you can edit the product details or add your own."
2. **0:15** Tick the consent box, press Start call. The bot greets, says it is an AI and that the call is recorded. Point at the timer, the status line and the live chat.
3. **0:30** Talk to it for about a minute. Ask what it costs, say "it is too expensive for us", then ask for a demo on Friday. Point out the grey text as you speak and the status changing between Listening, Thinking and Speaking.
4. **1:30** Press End call. Show the summary, requirements, objections, next steps and the status badge (Demo Requested here), then play the recording.
5. **1:50** Open Call history, show the previous calls with their statuses. Mention that it also works in Hindi and Telugu and that a silent customer ends as No Response.

## Limits to know about

- **Browser:** voice input needs Chrome or Edge. Other browsers can hear the bot and type replies. Speech recognition in Chrome is processed by Google's speech service, which the consent text mentions.
- **Telugu and Hindi voices:** the bot's spoken voice comes from voices installed on the device. If none is installed, the app shows a notice and uses a default voice. Windows, Android and Chrome OS usually include Hindi and Telugu voices.
- **Recording:** it captures the microphone. With speakers (no headphones) the bot's voice is picked up too. With headphones only the customer's side is recorded. The transcript always has both sides.
- **History is per browser:** calls are saved in the browser that made them. Clearing site data removes them. For shared history across devices, store calls in a database on the server.
- **Demo products** (FlowDesk, LedgerLite, ClassNest) are made up. Prices and features are examples, and the bot is instructed not to go beyond the facts it is given.
- **Cost:** each call uses a few dozen small API requests plus one for the summary. The conversation uses `claude-haiku-5-5` for speed and the summary uses `claude-sonnet-5-5`. Change either with `CHAT_MODEL` and `ANALYSIS_MODEL`.
