## Browser-Companion
A full voice assistant that lives in your browser and can control and navigate for you. Uses LiveKit platform and claude browser toolset for optimal navigation and realtime experience.

### Features
- Realtime voice conversation experience using `LiveKit` framework
- Seamless navigation experience by voice commands
- Nostalgic look (Clippy is Back!)

### Basic Diagram
<img width="2416" height="450" alt="Architecture-Starter" src="https://github.com/user-attachments/assets/a9d0eab1-2bc3-4d94-b4c8-d9dd8f67c052" />

## Setup
Needs a Chromium-based browser

1. **Load the extension.**: Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the `extension` folder in this repo.

<img width="1921" height="193" alt="Screenshot 2026-10-11 083006" src="https://github.com/user-attachments/assets/cda155fb-0ebc-4bc2-b667-8140cdea3dac" />


2. **Finish the setup page** (it opens on install; or right-click the extension icon → Options):
   - Click **Allow microphone**.
   - Set the service URL and Access Token to whatever is required and check connection.
3. **Use it.** Pin the extension, click its toolbar icon to start a call, and click it again to end it. Right-click Clippy for volume and size, and drag him to move him.


## TODO (Future ideas)
Performance:
- Classify when the tone actually indicates an end of sentence, not just by time
- Preemptive generation and seperate thread for actions
- [Qwen-Audio-Jev](https://arxiv.org/html/2610.21614v1), assumes 20x speed in output. Must try
- Dissect inference pipeline to explore more optimizations

Usability:
- Gaze area detection to enhance usabilty
- Extend the functionality to phones
- GUI Grounding models incorporation
- Extend usage to computer-use, not just browser
- Add "Assistant Mouse cursor" To showcase what the model is doing right now. Similar to dual cursors in Figma or other collaborative sites
