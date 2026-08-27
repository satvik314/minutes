// One-time microphone grant. A permission given to any page of the extension
// covers them all — including the offscreen capture document, which cannot
// show prompts itself.

const allow = document.getElementById('allow');
const done = document.getElementById('done');

allow.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    allow.classList.add('hidden');
    done.textContent = 'All set — back to your meeting.';
    done.classList.remove('hidden');
    setTimeout(async () => {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id) chrome.tabs.remove(tab.id);
    }, 1600);
  } catch (e) {
    allow.classList.add('hidden');
    done.textContent = 'No microphone, then — Minutes will still take down the tab’s audio.';
    done.classList.remove('hidden');
  }
});
