## Browser-Companion
A full voice assistant that lives in your browser that can control and navigate for you. Uses LiveKit platform and claude browser tools toolset

## Setup
Needs a Chromium-based browser

1. **Load the extension.**: Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the `extension` folder in this repo.
2. **Finish the setup page** (it opens on install; or right-click the extension icon → Options):
   - Click **Allow microphone**.
   - Set the service URL and Access Token to whatever is required and check connection.
3. **Use it.** Pin the extension, click its toolbar icon to start a call, and click it again to end it. Right-click Clippy for volume and size, and drag him to move him.


## TODO (Future ideas)
Performance:
- Classify when the tone actually indicates an end of sentence, not just by time
- Preemptive generation and seperate thread for actions
- Dissect inference pipeline to explore more optimizations

Usability:
- Gaze area detection to enhance usabilty
- Extend the functionality to phones
- GUI Grounding models incorporation
- Extend usage to computer-use, not just browser
