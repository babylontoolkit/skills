window.PLAN_SUMMARY = {
  "schema": 1,
  "title": "Camera Session",
  "outcome": "A saved view remembers every render setting",
  "stamp": "Fixed on 2026-10-19",
  "lead": [
    "A saved Camera Session view now keeps every setting its render depends on. Loading a view shows all of them in the panel. **Render Current View** and **Render All Cameras** now render each view with its own settings."
  ],
  "sections": [
    {
      "kind": "impact",
      "heading": "The plan summary",
      "blocks": [
        "Saved views keep working; nothing needs migrating. Two things are worth knowing:",
        {
          "list": [
            "**Per-instance object IDs come back on** for a view saved before this fix, because that view never stored the setting. If a view was used with it off, turn it off and Update the view once.",
            "**An orthographic view saved before this fix still gets its framing size worked out the old way** each time it is loaded. It no longer gets wider. Update it once to store its framing."
          ]
        }
      ]
    },
    {
      "kind": "wrong",
      "heading": "What was wrong",
      "blocks": [
        {
          "numbered": true,
          "list": [
            {
              "text": "**Render All Cameras ignored each view's own output settings.** When the batch started, it read these from the panel and used them for every view:",
              "items": [
                "width and height;",
                "size preset;",
                "screen percentage;",
                "Image Types (beauty, edges, mask, normal, depth, area)."
              ]
            },
            "**Load did not show every saved setting in the panel.** The Line Sources boxes always showed unticked, and ticking one turned the other three off."
          ]
        }
      ]
    },
    {
      "kind": "changed",
      "heading": "What has changed",
      "blocks": [
        {
          "list": [
            "**Both render buttons render each view with its own saved settings.** A view now comes out the same from Render All as from Load + Render Current View.",
            "**Load shows every saved setting in the panel**, including Line Sources. Ticking one box changes only that one."
          ]
        }
      ]
    },
    {
      "kind": "unchanged",
      "heading": "What has not changed",
      "blocks": [
        {
          "list": [
            "**Some settings belong to the device, not to a view**, so they are not saved with one: the performance level and the anti-aliasing sample count (lower on phones). The same view can look slightly different on a phone and on a desktop."
          ]
        }
      ]
    },
    {
      "kind": "checked",
      "heading": "How it was checked",
      "blocks": [
        "We tested in Chrome using local cards only; nothing was saved to the server.",
        {
          "list": [
            "Render All was run on three views with the panel left at 640×480. Each view rendered at its own size with its own images: one at 2528×1696, one at 1200×800, and one with no saved output settings at the panel's 640×480.",
            "Pressing Update right after Render All changed nothing in the last view."
          ]
        }
      ]
    }
  ],
  "writtenAt": "2026-10-19 16:40"
};
