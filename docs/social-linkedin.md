# LinkedIn post

Paste as-is. Attach the demo video link (LinkedIn will unfurl the YouTube card) or upload
a 30-60s clip natively for better reach. `#AllThingsAgenticHackathon` is required for the bonus.

---

I spent this month building an AI that does not have a chat box.

Most agent demos are a text field that waits for you. I wanted to know what it feels like when an AI lives somewhere, remembers on its own, and gets better while you sleep. So I built Memory Keepers: a 3D island where every layer of your life has its own keeper.

Each keeper is a Google ADK agent that guards one topic. Music, films, work, dreams. You walk up and tell her something, and she reads the source herself, a talk, a song, a film, and writes it into a book in your own voice. Ask her later and she answers only from books she actually opens, never invented.

Then the part I am proudest of. Every night the island dreams. A consolidation run links what your books share across every shelf, builds a knowledge graph, and gives birth to darker keepers born from the patterns that keep returning. The fears, the things you look away from. You can sit with one and it will connect two of your memories and ask you a question back.

The stack: Gemini 3.5 Flash on Vertex AI, Google ADK with one AgentTool per keeper so the root can fan out and synthesise, Cloud Run, Firestore, Pub/Sub and Cloud Scheduler for the nightly dream, Cloud Text-to-Speech and Speech-to-Text for voice.

One switch changes the brain: Gemini in the cloud, or Gemma running entirely on your own machine. Same code. Your memories never have to leave your hardware.

Built solo, open source, for the All Things Agentic Hackathon.

Demo, 3 minutes: https://youtu.be/2m9c1UvCAdA
Full Google Cloud setup, click by click: https://youtu.be/-5D4t0W_PBM
Code: https://github.com/hec-ovi/memory-keepers

#AllThingsAgenticHackathon #GoogleCloud #Gemini #AIAgents #OpenSource
