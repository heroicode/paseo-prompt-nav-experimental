Experimental. Adds Prev and Next pills to the composer on iOS and Android that jump the chat between your own messages.

Paseo has no plugin API for scrolling the chat, so this reads private React and React Native internals. Any Paseo update can break it. When it can't complete a jump, a pill briefly shows why: No fiber, No root, No list, No metrics or Missed. Top means you reached the oldest loaded prompt, and pressing Prev again after older history loads continues upward. It does nothing on desktop or web, which have the chat outline.
