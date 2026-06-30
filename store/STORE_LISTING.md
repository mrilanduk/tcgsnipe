# Chrome Web Store listing — Pulse Price Scanner

Everything you paste into the Web Store Developer Dashboard when submitting.

## Basics
- **Name:** Pulse Price Scanner
- **Summary (≤132 chars):** Shows the live market value of Pokémon cards inline on eBay, Vinted & Facebook Marketplace listings.
- **Category:** Shopping
- **Language:** English (UK)
- **Visibility:** Unlisted (install by link) — change to Public later if you want.

## Detailed description
```
Pulse Price Scanner puts live Pokémon card market values right on the listings you're already browsing.

As you scroll eBay, Vinted and Facebook Marketplace, it reads each card listing, looks up its current market value, and shows it inline as a clean price badge — so you can spot a deal at a glance without opening a price-checker in another tab.

• Inline price badge on every detected card listing
• Reads the listing's condition (and eBay's Condition field) and shows the matching price — NM, LP, MP or HP, colour-coded
• Hover any badge for the full breakdown: Near Mint, Lightly Played, Moderately Played, Heavily Played, plus graded (PSA/CGC/BGS) values
• Right-click any selected text on any page to price a card on demand
• Lazy, cached lookups so it stays fast and light

Access is by invite code from Pulse Collective. Enter your code once to unlock the extension.

Pricing data is provided via Pulse Collective's service. This is an independent tool and is not affiliated with eBay, Vinted, Facebook, Nintendo, or The Pokémon Company.
```

## Single purpose (required field)
```
Display the current market value of Pokémon trading cards inline on supported marketplace listing pages.
```

## Permission justifications (required per item)
- **host access to ebay / vinted / facebook**: Read the card title and condition shown on listing pages so the matching market price can be looked up and displayed.
- **host access to instore.pulsecollective.co.uk**: This is the pricing service the extension queries for card market values.
- **storage**: Save the user's access code and their on/off preferences locally.
- **contextMenus**: Add a right-click "price this card" option for selected text.
- **scripting + activeTab**: Show the price result overlay on the current tab when the user uses the right-click option.
- **Remote code:** None. All code is contained in the package.

## Data disclosures (Privacy practices tab)
- The card title and condition text from listing pages on the supported sites are sent to `instore.pulsecollective.co.uk` solely to look up a price.
- The user's access code is sent to that same service to authenticate.
- No personally identifiable information, browsing history, or analytics is collected, and nothing is sold or shared with third parties.
- Tick: *"I do not sell or transfer user data to third parties, outside of the approved use cases"*, and that data is used only for the single purpose above.
- **Privacy policy URL:** https://instore.pulsecollective.co.uk/privacy

## Assets
- **Icon (128×128):** `icons/icon128.png`
- **Screenshot (1280×800):** `store/promo-1280x800.png` — a product mockup. Replace with a real screenshot of the extension on a live listing before publishing if you prefer.
- Small promo tile (440×280) is optional; only needed for featuring.

## Package
Upload `pulse-price-scanner.zip` (built from the repo — runtime files only). See README / build step.
```
