# Notes on narrow screens

2026-11-14. Small change; agreed in conversation.

## Why

A spec book is read on a desktop and on a phone at the same time. Floating stickies with arrows need room beside the
text; on a phone they cover it, and a sticky placed on a desktop lands somewhere meaningless on a phone.

## What

- **By width, responsive.** A window too narrow for a sticky beside the text (the same width at which the contents
  sidebar hides, 860 px) shows notes inline; a wider one shows floating stickies. Resizing switches between them.
- **The spot stays exact.** A note's pin still marks the letter (or the spot in a mockup) it was dropped on, the same
  for every reader. On a narrow screen the pin is a 3 px dot joined to its card by a 1 px line, so it covers almost
  no text.
- **Cards under the item.** The notes show as cards in a list directly under the requirement, screen, heading or
  decision they are on, in book order. The card is the note's editor: a tap selects it, a tap on the selected card edits it, Enter or Esc finishes, a long press deletes it (Delete or Backspace on a keyboard).
  Comment mode works the same: tap a spot, and a new card opens there, ready to type. Live typing shows on the card.
- **No positions on a phone.** A narrow screen never moves a note's sticky or pin and never saves a sticky position
  (`dx`, `dy`); it ignores where desktop readers placed their stickies.

## Approaches considered

- **By width (chosen):** one rule for any reader; never draws stickies over the text.
- **By device:** a squeezed desktop window would keep floating stickies over the text.

## Left to the builder

The line runs from the card's nearest edge to the dot's center. Tapping a card marks its dot (it grows while the card
is being edited).
