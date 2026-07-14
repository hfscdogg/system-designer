# Livewire — Proposal & Scope of Work

| | |
|---|---|
| **Prepared for** | Henry Clifford |
| **Prepared by** | Livewire — System Designer (pilot) |
| **Date** | July 14, 2026 |
| **Quote state** | **Draft** — not yet promoted; pricing not final |
| **Valid** | 30 days from promotion past Draft |

---

## Project overview

A whole-home technology package for the Clifford residence, scoped in an
interview to **four spaces** — the kitchen/family room, the primary suite,
the home office, and the porch/patio — in a **finished home** (no open
walls), at the **$50–100k** tier. Rather than spreading wider, the budget
goes **deeper**: wired architectural audio in every space, a theater-grade
family room with discrete surround, and motorized shades in the main living
spaces. Each system runs on its own best-in-class app (Sonos, Lutron,
UniFi) with one universal remote in the family room — no separate control
processor, by your choice.

---

## Scope of work by system

### 1. Network & infrastructure

The foundation everything else stands on: a rack-mounted, UPS-backed wired
backbone with headroom for the added wired audio and theater endpoints, and
Wi-Fi covering all four spaces plus the patio.

| Qty | Item | Purpose |
|---|---|---|
| 1 | Ubiquiti UniFi Dream Machine Pro | Gateway, routing, network controller |
| 1 | Ubiquiti UniFi Pro Max 24 PoE switch | Wired backbone, powers APs & cameras |
| 3 | Ubiquiti UniFi U7 Pro access point | Coverage across all four spaces + patio |
| 1 | Structured wiring enclosure & patch | Clean, serviceable head-end |
| 1 | APC rack-mount UPS | Keeps network alive through outages |

*Included labor: head-end build, retrofit cable runs to the office, theater
wall, and audio locations, network configuration, and coverage verification.*

### 2. Lighting control

Scene-based lighting in the kitchen/family room, primary suite, and office.
Lutron's wireless dimmers swap into existing switch boxes — no retrofit
penalty — and tie into the same scenes as the shades below.

| Qty | Item | Purpose |
|---|---|---|
| 1 | Lutron RadioRA 3 main processor | Lighting & shade brain |
| 8 | Lutron Sunnata RA3 dimmers | Scene-capable dimming in the four spaces |
| 3 | Lutron keypads (Sunnata class) | Scene control at entry & bedside |
| 1 | Lutron wireless motion sensor | Auto-off where it earns its keep |

*Included labor: dimmer and keypad swap-ins, processor programming, and a
scene-tuning session with the family.*

### 3. Motorized shades

Battery-powered Lutron rollers in the kitchen/family room and primary suite
— whisper-quiet, no wiring in finished walls, on the same keypads and scenes
as the lights ("Goodnight" dims the room *and* drops the shades).

| Qty | Item | Purpose |
|---|---|---|
| 6 | Lutron Triathlon RA3 battery roller shades | Kitchen/family (4) + primary suite (2) |
| 1 | Fascia & bracket hardware set | Finished look, fabric from sample deck |

*Included labor: measurement, mounting, RA3 integration, and scene
programming. Fabric selection happens at the design review.*

### 4. Whole-home wired audio

Proper in-ceiling speakers in every interior space — cut in with retrofit
brackets, painted to disappear — plus wired outdoor speakers on the patio.
Each zone gets its own amplifier; group them or run them independently.

| Qty | Item | Purpose |
|---|---|---|
| 4 | Sonos Amp | One per zone: kitchen, primary, office, patio |
| 6 | Sonance VP66R in-ceiling speakers | Kitchen (pair), primary (pair), office (pair) |
| 2 | Sonance Mariner outdoor speakers | Porch / patio zone |

*Included labor: retrofit ceiling cuts and wire fishing, amp rack
integration, zone calibration, and app setup on the family's devices.*

### 5. Theater-grade family room

The family room becomes the showpiece: a reference-class big screen and a
discrete surround system with real processing — not a soundbar — with the
speakers in the walls and ceiling where you never see them.

| Qty | Item | Purpose |
|---|---|---|
| 1 | Sony BRAVIA 9 85" Mini-LED display | Reference-grade big screen |
| 1 | Marantz Cinema 50 AV receiver | Discrete surround processing & amplification |
| 3 | Sonance in-wall LCR speakers (retrofit) | Front stage behind the fabric grilles |
| 2 | Sonance in-ceiling surround speakers | Rear/height surround |
| 1 | SVS SB-2000 Pro subwoofer | The part you feel |
| 1 | Apple TV 4K | Primary streaming source |
| 1 | Universal remote & integration | One remote for the whole room |
| 1 | Low-profile mount & concealed wiring kit | Clean wall, no visible cables |

*Included labor: display mounting with in-wall concealment, retrofit in-wall
and in-ceiling speaker installation, receiver calibration (room correction),
and source/remote programming.*

### 6. Surveillance

Coverage of the driveway, front door, and rear yard, recorded locally — no
monthly cloud fee — and viewable from anywhere.

| Qty | Item | Purpose |
|---|---|---|
| 3 | Ubiquiti UniFi AI Pro cameras | Approach & yard coverage, smart detection |
| 1 | Ubiquiti UNVR network video recorder | Local 24/7 recording |
| 1 | UniFi G4 Doorbell Pro | Front-door video + two-way talk |

*Included labor: camera placement, exterior PoE runs via soffit/attic routes,
recorder setup, and mobile viewing configuration.*

---

## Investment summary

Placeholder pricing at street-price magnitude — **final pricing comes from the
D-Tools catalog when this quote is promoted past Draft.**

| System | Equipment | Labor & programming |
|---|---|---|
| Network & infrastructure | $5,100 | $4,100 |
| Lighting control | $5,400 | $2,700 |
| Motorized shades | $8,100 | $1,400 |
| Whole-home wired audio | $8,100 | $3,500 |
| Theater-grade family room | $15,800 | $3,200 |
| Surveillance | $2,700 | $2,200 |
| **Subtotals** | **$45,200** | **$17,100** |

**Project total (placeholder): $62,300**

That sits in the heart of the $50–100k tier with meaningful headroom for
retrofit surprises and fabric/finish upgrades before the ceiling.

---

## Assumptions & exclusions

The core ask, space list, budget tier, site context, and depth priorities
were confirmed by interview — they're decisions, not assumptions. What
remains flagged:

1. Attic or crawl access is assumed available for speaker wire fishing, the
   office network drop, patio speaker wiring, and exterior camera runs. If
   routes require wall opening and patching, that's a change order, not
   hidden labor.
2. Retrofit in-wall speakers on the theater front stage assume standard stud
   bays without fire blocking at speaker height; blocking discovered at
   install shifts those channels to on-wall or in-ceiling equivalents.
3. Shade count assumes 4 windows in the kitchen/family room and 2 in the
   primary suite; final count and fabric set at measurement.
4. Display sized at 85" pending a wall measurement.
5. You declined a unified control processor — each system runs its native
   app, with the universal remote covering the family room. Control4-class
   control can be layered on later without re-wiring.
6. Existing internet service (modem/ONT) assumed in place; ISP coordination
   excluded.
7. Lighting covers the four in-scope spaces, not every fixture in the house.
8. All product models are representative pending final match to the D-Tools
   catalog; equivalent-or-better substitutions may be made at equal or lower
   price.
9. Electrical work beyond low-voltage (new circuits, panel work) by owner's
   electrician.

---

## What happens next

1. You mark up anything above — especially the access assumptions (#1, #2)
   and the shade count.
2. We revise, the design goes through Livewire's internal review, and the
   quote is finalized against the D-Tools catalog.
3. The quote is promoted out of Draft and you receive the live D-Tools
   opportunity link to approve.
