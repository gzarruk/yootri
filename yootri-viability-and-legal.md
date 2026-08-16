# yootri — commercial viability & legal risk assessment

**Prepared 16 August 2026 · for Gustavo Zarruk · Norway (EEA)**

*Research briefing, not legal advice. Points where you'd need an actual Norwegian lawyer are marked ⚖️.*

---

## The short version

**Legally, you are in a better position than you think.** A training planner that plans training is not a medical device, and it doesn't become one because you lack a certification. There is no title protection for "coach" or "personlig trener" in Norway. The regulatory risk is almost entirely a *marketing copy* problem, and it is cheap to control.

**Commercially, the plan has one structural flaw that outweighs everything else:** the premise "buyers won't pay a subscription on top of their AI subscription" is factually inverted. A ChatGPT Plus or Claude Pro subscription **does not include API access**. Anyone using your BYO-key coach would be paying a *second, metered* bill on top of the subscription they already have. That gate probably removes 70–95% of otherwise-willing buyers.

**And on your actual stated goal — recovering deployment cost — you have already won.** GitHub Pages is free, Firestore's free tier will absorb thousands of hobbyist users, and your only real cost is the domain. You're spending roughly **$15–20/year**. Selling licences would *create* costs and obligations that don't currently exist: merchant fees, a support obligation to paying customers, EU consumer-law duties, and — from 11 September 2026 — Cyber Resilience Act reporting obligations that have **no exemption for individual developers**.

The three things worth actually doing are at the end.

---

## 1. What you've built, assessed honestly

The engineering is good: single-file, no build step, no dependencies, local-first, tested coach-engine modules, optional sync. That architecture is exactly what a small number of people online will admire loudly, and it is also, coincidentally, your best legal defence (more on that in §4.3).

The feature set — 16-week 70.3 plan with Base/Build/Peak/Taper, drag-and-drop rescheduling, completion tracking, weekly and cumulative load, an SVG season chart — is solid and genuinely useful.

It is also, in 2026, **table stakes given away for free by Garmin**. Garmin Coach now covers sprint, Olympic and half-distance triathlon with brick workouts, two-a-days and optional strength, adapts daily, and is free with a compatible watch that essentially every 70.3 athlete already owns. Garmin also **acquired TrainingPeaks on 22 July 2026**.

That single fact reframes the whole commercial question. You are not entering an underserved market — you are entering a market whose floor was just set to zero by the hardware vendor your customers already buy from.

---

## 2. The competitive picture

| Product | 2026 price | Model |
|---|---|---|
| **Garmin Coach** (incl. triathlon) | **Free** with device | — |
| **Intervals.icu** | Free core, $4/mo optional supporter | Donationware — 160,000+ active athletes, solo developer |
| **Final Surge** | **Free** for athletes | Freemium |
| **Runalyze** | Free tier; €27.50–60/yr | Freemium |
| **Golden Cheetah** | Free, open source | — |
| **TrainingPeaks Premium** | $19.95/mo, $134.99/yr | Subscription (now Garmin-owned) |
| **TrainingPeaks plan marketplace** | **~$28** per 18-week 70.3 plan | One-time |
| **TriDot / Humango / Athletica / AI Endurance** | $15–39/mo, $155–189/yr | All subscription |
| **WKO5** | **$169 one-time** | The *only* perpetual-licence precedent in the category — and TrainingPeaks owns it |
| **Static 70.3 plan PDFs** (MyProCoach, Scientific Triathlon, Gumroad sellers) | **$24–75** | One-time |

A 2026 *220 Triathlon* roundup of eleven major triathlon apps concluded flatly: **"No one-time purchase options are mentioned across any app reviewed."**

**The white space you identified is real — but it is empty because the market rejected it, not because nobody thought of it.** The revealed preference for solo-built endurance software is *free, with a tip jar*. Intervals.icu is the proof: one developer in Cape Town built a better product than the paid incumbents, gave it away, took optional $4/mo donations, reached 160,000 athletes, and went full-time on it. Meanwhile **Today's Plan — well-funded, Specialized-backed, well-regarded — shut down in March 2024.**

### Market size, unromanticised

- Ironman Group: **250,000+ race registrations in 2025** (a record), but registrations ≠ people; realistically **~120–180k unique long-course athletes globally**.
- USA Triathlon: 303,000 members, but **73% race sprint/super-sprint/Olympic only** — the long-course, plan-buying subset is a minority.
- US finishers peaked at **564,000 in 2011** and sit around **302,000** today. 82% of the 2011–2019 decline happened *before* COVID.
- TrainingPeaks — 20 years old, category leader, ~$75–130M valuation — has an estimated **~100,000 paying athlete subscribers across all endurance sports worldwide**.

The addressable population of long-course triathletes who pay for self-directed training software is **tens of thousands globally**, already served by a free Garmin product, a free 160k-user platform, and $28 static plans.

---

## 3. The BYO-key problem — the thing that decides this

This is the part I'd want you to sit with, because it inverts the core premise.

**A ChatGPT Plus / Pro or Claude Pro subscription does not grant API access.** They are separate products on separate billing systems. To use your coach, a buyer must: create a separate developer account, attach a card to a second billing system, generate a key, and understand token pricing. Their existing subscription is worthless here.

So the pitch "don't pay a subscription on top of your AI subscription" actually means "pay a metered API bill *in addition to* your AI subscription, after doing developer onboarding."

The funnel:
- **~2% of US households** pay for *any* generative-AI subscription (PNC data, 2026).
- OpenAI has ~4 million developers against ~900 million weekly ChatGPT users — **0.4%**.
- Among affluent 35–50 endurance athletes, maybe 10–20% have a paid AI subscription; a small fraction of those have or would set up API billing.

**Realistic estimate: 2–5% of your target audience could use the coach feature today without significant hand-holding.**

### The security angle is also uncomfortable

- **OpenAI's own policy is explicitly against it:** *"Never deploy your key in client-side environments like browsers or mobile apps... Requests should **always** be routed through your own backend server."* There is no BYOK carve-out.
- **Anthropic permits it, pointedly.** The header is literally named `anthropic-dangerous-direct-browser-access`, and the docs note the BYOK pattern as a recognised legitimate exception — while warning the key is exfiltrable.
- Your app is a single file on GitHub Pages holding a user's key in `localStorage`. Any XSS, any compromised dependency, any Pages/DNS takeover, and every user's key leaks. Unlike a password, a leaked API key **bills the victim silently**. That is an uninsurable liability for revenue measured in hundreds of dollars.

### Local agent / MCP as the alternative

Not viable for this audience. MCP in 2026 is an enterprise and developer story. Asking a 42-year-old age-grouper to run a local MCP server so their Thursday swim set gets adjusted is a non-starter. The only consumer-viable variant is a thin server *you* operate — which reintroduces exactly the hosting cost and recurring obligation the one-time fee exists to avoid.

---

## 4. Legal risk register

Ranked by how much it should actually change your behaviour.

### 4.1 🟢 Medical device (MDR) — you are out, and staying out is free

**This is the risk you asked about, and it's the one you have least to fear from — provided you watch your words.**

The test is **intended purpose**, not functionality, and intended purpose is legally defined by *"the data supplied by the manufacturer on the label, in the instructions for use or in promotional or sales materials or statements"* (MDR Art. 2(12)). **Your landing page copy and your system prompt are the legal instrument that determines classification.** Not your code.

Three sources point the same way:

- **MDR Recital 19:** *"software intended for life-style and well-being purposes is not a medical device."*
- **MDCG 2019-11 Rev.1** (updated 17 June 2025), §3.1: *"...**wellness or fitness apps, do not qualify as MDSW**."*
- **DMP's own November 2025 webinar** states the boundary in four words: **"Livsstil/trening/velvære = ikke medisinsk utstyr."** Note that *trening* is named explicitly.

**A common misconception worth clearing up:** Rule 11 of Annex VIII ("software providing information used to take decisions with diagnosis or therapeutic purposes → Class IIa") is a **classification** rule, not a **qualification** rule. You only reach it *after* the software has already qualified as a medical device. A fitness app never gets there. The "software that gives advice = Class IIa" panic doesn't apply to you.

Two things that do **not** help you, so don't rely on them:
- **Being a hobbyist or giving it away free is irrelevant.** MDR Art. 2(27) covers supply "whether in return for payment or free of charge," and Art. 2(30) defines manufacturer as a "**natural** or legal person."
- **"But my app is low risk" is not an argument.** DMP's deck says it directly: *"Risiko for skade er ikke et kriterium for om programvaren kvalifiserer som medisinsk utstyr."* Only absence of medical purpose keeps you out.

**Safe language** — training, performance, fitness, planning, periodisation, training load, TSS/CTL/ATL, pace and power zones from user-entered test results.

**Language that would drag you into MDR scope:**

| Phrase | Why it bites |
|---|---|
| "Prevents injury" / "reduces injury risk" | Art. 2(1) injury limb. ⚖️ Textually arguable, but do not build on the argument. |
| "Detects overtraining" / "RED-S screening" | Both are recognised clinical conditions → detection = diagnosis of disease. Clear scope-in. |
| "HRV-based readiness — tells you when your body needs rest" | Monitoring a physiological process to produce a health-state conclusion. |
| "Recovery monitoring" / "health monitoring" | "Monitoring" + "health" supplies the medical purpose almost by itself. |
| "Medically validated" / "clinically proven" / "doctor-designed" | Triggers MDR Art. 7 *and* consumer-law substantiation duties. |
| A CE mark | Per-se prohibited under UCPD Annex I point 4 if unauthorised. |

Falling into scope means Class IIa, a Notified Body, ISO 13485 QMS, clinical evaluation and post-market surveillance. **There is no self-certification route above Class I.** It would end the project. Staying out costs you nothing but discipline.

**Free resource worth using:** Norway has a cross-agency advisory service for AI in health (Helsedirektoratet, DMP, Datatilsynet, Helsetilsynet) that answers regulatory questions **free of charge**. Cheaper first stop than a lawyer.

### 4.2 🟢 "Coach" as a word — legally fine

Neither "coach" nor "personlig trener" is a protected title in Norway. Store norske leksikon is explicit: *"yrket [er ikke] lovregulert og tittelen «personlig trener» er ikke beskyttet."* Protected titles are the ~30 health-personnel titles under helsepersonelloven § 48 — trainer/coach is not among them.

**The constraint isn't title law, it's claim law.** You may call it an "AI coach." You may not imply it is *certified*, a *physiotherapist*, or *medically supervised*. Under markedsføringsloven § 7 the **burden of substantiating every performance claim sits on you** — Forbrukertilsynet: *"Det er deres ansvar å sannsynliggjøre at påstander dere bruker i markedsføring er korrekte."* "Get faster" is puffery; "improves your VO2max by 12%" needs a study you don't have.

### 4.3 🟡 GDPR — your biggest *avoidable* burden

Longitudinal training + heart-rate data, especially once an AI draws conclusions from it, should be treated as **Article 9 special-category health data**. The Article 29 Working Party test: data becomes health data when conclusions are drawn about health status *"regardless of accuracy or legitimacy."* The moment your coach says "you look under-recovered," you're squarely in that limb. **The AI feature is what converts your dataset into Art. 9 data.**

If it syncs to your Firestore project, you are the **controller**. That brings: explicit Art. 9(2)(a) consent (a ToS checkbox won't do — it must be separate, granular, affirmative, withdrawable), an Art. 28 DPA with Google plus SCCs, Art. 30 records, a privacy notice, data subject rights, 72-hour breach notification to Datatilsynet, and probably a short DPIA. Plus disclosure that every coaching prompt ships the user's training history to whichever LLM provider they configured.

**Local-first removes nearly all of it.** If data never leaves the browser and you never have access, there is no processing *by you*. No Art. 9 exposure, no DPIA, no breach-notification exposure, no transfer analysis. **This is the single highest-leverage risk reduction available, and it costs you a feature rather than money.** Your architecture is already local-first — keep cloud sync strictly opt-in behind separate explicit consent, or drop it.

### 4.4 🟡 Liability for injury — your disclaimer does not do what you think

**You cannot disclaim liability for personal injury against an EEA consumer.** Three independent layers block it:

1. **New Product Liability Directive (EU) 2024/2853, Art. 15:** *"The liability of an economic operator... is not, in relation to the injured person, limited or excluded by a contractual provision or by national law."* Non-derogable.
2. **Unfair Contract Terms Directive 93/13/EEC**, Annex para. 1(a) — terms excluding liability for death or personal injury. Formally a grey list; treated as effectively black.
3. **Avtaleloven § 36** — a Norwegian court can set aside any term *urimelig* to enforce. A B2C EULA excluding bodily-injury liability is the paradigm target.

The new PLD matters specifically to you:
- **Software is expressly a product** (Art. 4(1)), including browser-delivered software.
- **The only carve-out is FOSS supplied outside commercial activity** (Art. 2(2)). Charging $20–60 fails both limbs. **There is no revenue floor, no SME exemption, no distinction between you and Garmin.**
- **Old thresholds and caps are gone**, and Art. 10 **presumes defectiveness** where proof is "excessively difficult" due to technical complexity — written precisely for opaque AI systems.
- **Art. 11(2) removes the "defect arose later" defence** where the problem stems from a missing safety-relevant update within your control. **Shipping and walking away does not insulate you.**
- Applies to products placed on the market **after 9 December 2026**. ⚖️ Norway hasn't incorporated it into the EEA agreement yet — but EU-based buyers bring you into scope regardless.

**Empirically the risk is near zero.** I found **no reported case, US or EU, where a fitness/running/training app was held liable for injury from its training advice.** That's a finding, not a search failure. The US doctrinal shield has been *Winter v. G.P. Putnam's Sons* (9th Cir. 1991) — a publisher not strictly liable for a mushroom encyclopedia that sent readers to liver transplants, because ideas and expression aren't "products."

**But that shield is eroding, specifically because of AI.** In *Garcia v. Character Technologies* (M.D. Fla., May 2025) a federal judge declined to dismiss, treating a chatbot as **a product, not speech**. *Raine v. OpenAI* pleads design defect against an LLM. The EU has legislated software into strict liability with reversed burdens. **The AI-coaching layer is precisely the feature that attracts the new theories.**

#### What actually works: warnings, not exclusions

A warning is legally *more* valuable than an exclusion, because under both the PLD and Norwegian culpa, "presentation" and adequacy of warnings feed into whether the product is **defective at all** — which is the argument that wins, rather than an exclusion that gets struck out.

The incumbent pattern worth copying (Strava and Peloton are the best-drafted):

- **Strava:** *"YOUR USE OF THE SERVICES AND ANY ATHLETIC ACTIVITIES DONE PURSUANT TO OR RELATED TO YOUR USE OF THE SERVICES (INCLUDING WITHOUT LIMITATION, **FOLLOWING A TRAINING PLAN OR RECOMMENDATION**) IS AT YOUR OWN RISK"* — note it names the training-plan feature explicitly.
- **Whoop:** *"WHOOP Services are not medical advice and... are not a medical device."*
- **Peloton:** requires users to **affirmatively attest** either to no cardiac history / dizziness / balance / joint problems, **or** that a physician approved participation. This is the single most transferable idea.
- All of them include **a savings clause** for jurisdictions that don't permit the exclusions.

Draft language is in §7.

### 4.5 🟠 The "perpetual licence" trap — more likely to cause you actual grief than any of the above

Selling to EEA consumers engages **digitalytelsesloven** (LOV-2022-06-17-56), implementing the Digital Content Directive. It is **ufravikelig** — terms to the consumer's detriment simply don't bind.

**The update obligation is the problem.** For a single act of supply, you owe updates *"for the period of time that the consumer may reasonably expect, given the type and purpose of the digital content."* Forbrukertilsynet: **"no specific duration is defined."** ⚖️ This is the single most legally uncertain item in your whole plan. For a $20–60 licence marketed as durable, a Norwegian court would plausibly land in the **2–5 year** band — **and the word "perpetual" in your marketing actively lengthens the window you owe.**

Concretely: if an upstream AI API deprecation breaks the coach feature, that's a **conformity problem**, not an act of God. Remedies cascade: repair → price reduction → refund.

Norway's tail is also longer and vaguer than the EU's clean two years — no fixed *reklamasjonsfrist*, general three-year *foreldelse* plus a one-year extension from discovery of hidden defects. And Art. 12 **reverses the burden of proof for the first year**: you must prove conformity at delivery.

**Also:** the default 14-day withdrawal right applies, and if you fail to inform buyers of it, **the period extends to 12 months** — a year of no-questions refunds. Switching it off requires all three legs of CRD Art. 16(m) / angrerettloven § 22: prior express consent to immediate performance, acknowledgment of losing the right, *and* durable-medium confirmation. And your checkout button must say **"order with obligation to pay"** or an unambiguous equivalent — if it doesn't, CRD Art. 8(2) says **the consumer is not bound by the contract at all**.

**Recommendation: do not use the words "perpetual" or "lifetime."** Sell *"a licence including N years of updates; the version you have keeps working."* That's the Sublime Text model, it's honest, and it caps the open-ended obligation.

### 4.6 🔴 Cyber Resilience Act — the genuinely under-priced risk

This is the one nobody expects, and for you it's heavier than tort.

**Regulation (EU) 2024/2847** covers "products with digital elements" whose foreseeable use includes a direct or indirect data connection — explicitly including browser applications. An app that calls an AI API qualifies.

- **In force since 10 Dec 2024. Vulnerability and incident reporting obligations from 11 September 2026** — under four weeks away. Full application 11 December 2027.
- Obligations: CE marking, declaration of conformity, **free security updates over a support period generally expected to be at least five years**, a documented vulnerability-handling process, an SBOM, and **24-hour reporting of actively exploited vulnerabilities**.
- **There is no micro-enterprise or individual-developer exemption.** Only non-commercial open source is out of scope, with a lighter "steward" regime for some maintainers.

For a single-file vanilla-JS app maintained by one person in his spare time, **the CRA is a heavier ongoing burden than any liability scenario in this document**, and its five-year support expectation compounds the digitalytelsesloven update problem. ⚖️ Whether it reaches a browser-only app that calls a third-party API is worth a lawyer's view.

**If any single item should make you think "maybe don't sell into the EU," it's this one.** Note the asymmetry: **keeping it free and non-commercial (ideally open source) sidesteps the CRA entirely.**

### 4.7 🟡 EU AI Act — one obligation, one sentence to comply

Status after the Digital Omnibus (Regulation (EU) 2026/1744, in force 27 July 2026):

- You would be a **provider** of an AI system — not a deployer, not a GPAI model provider. Integrating a third-party model via API makes you a *downstream AI system provider*; mere prompting is nowhere near the fine-tuning threshold that would make you a model provider.
- **Not high-risk.** Annex III's only health-adjacent entries are health-insurance pricing and emergency triage. Neither applies. ⚠️ The one coupling risk: if you became a medical device under §4.1, you'd become high-risk *and* need a Notified Body. **The MDR question and the AI Act high-risk question are the same question.**
- **Article 50(1) applies from 2 August 2026 — i.e. now, and it was not deferred.** You must ensure users are informed they're interacting with an AI. Compliance cost: one line at first interaction. There's a decent argument the "obvious" exemption applies to a feature you paste your own API key into, but **the disclosure is free and the argument isn't certain.**
- Chapter III high-risk obligations were pushed to 2 Dec 2027 / 2 Aug 2028 and don't apply to you regardless.
- **Norway hasn't implemented the AI Act at all.** The KI-lov draft goes back out for consultation in autumn 2026; a bill to Stortinget is targeted for spring 2027. Your only real exposure is via EU-based buyers, where the Act applies extraterritorially.
- Penalties for Art. 50 breaches cap at €15m *or* 3% of turnover, **whichever is lower for SMEs**. On near-zero turnover: negligible.

**Shipping system prompts strengthens the "provider" characterisation** — you're defining the AI system's intended purpose. Don't think of yourself as a neutral pipe. ⚖️ (Conversely, if you shipped *no* prompt and *no* orchestration — just a text box posting to a user-configured URL — the case for you being a provider at all weakens considerably. Not settled; a genuine lawyer question if you wanted to rely on it.)

### 4.8 🟢 Tax and VAT — easy at home, ugly abroad

**Norway:** no revenue threshold for hobby vs. næringsvirksomhet. The four-factor test turns on whether the activity is *egnet til å gå med overskudd* — **objectively capable of profit over time**. Your stated goal (cost recovery, not profit) is exactly what keeps it a hobby: no ENK registration, no business income tax. MVA registration only at **NOK 50,000** rolling over any 365 days.

⚠️ **But do not confuse the two regimes.** "Hobby" is a *tax* classification. It does **not** make you a non-trader for forbrukerkjøpsloven / digitalytelsesloven / angrerettloven, and the PLD doesn't care about scale at all. **You are a trader for consumer-law purposes from the first sale.** This is the most common mistake in this scenario.

**EU/UK VAT is the item most likely to be underestimated.** Norway is outside the EU VAT area. As a non-EU supplier of B2C electronic services into the EU, **VAT is due in the customer's Member State from the very first sale**. The €10,000 micro-business threshold is available *only to businesses established in the EU* — it does not help you. **UK is worse: no threshold at all** for a non-established taxable person, 20% from sale one.

The relief valve is the **Non-Union OSS** — register in one Member State, file one quarterly return covering all 27. Still a real quarterly obligation, and absurd for a cost-recovery hobby.

**US sales tax:** economic nexus is typically $100,000 into a single state. At $20–60 a licence this is unreachable. Deprioritise.

**Conclusion: use a merchant of record.** An MoR becomes the legal seller — Paddle's buyer terms: *"Paddle is an authorised reseller of Products for Suppliers, which means you purchase the Product from Paddle."* That means Paddle carries EU/UK VAT, US sales tax, invoicing, **and the statutory withdrawal-right machinery**.

| Option | Fee | Verdict |
|---|---|---|
| **Gumroad** | 10% + $0.50 (~12% effective) | Full MoR since Jan 2025. Zero setup, sell in an afternoon. **~$4.80 on a $40 licence — irrelevant at your goal.** Best for simplicity. |
| **Paddle** | 5% + $0.50 (~6.9% with FX) | Better checkout, licence-key tooling, lower per-unit. Requires approval. **Does not require incorporation.** |
| Stripe Managed Payments | ~8.9–10% international | Most expensive; Norway seller eligibility needs checking. Skip. |
| FastSpring | Unpublished, sales call | Enterprise motion. Wrong shape. Skip. |
| **Bare Stripe/PayPal** | — | **Don't.** Leaves you as seller of record: OSS registration, UK VAT from sale one, invoicing and withdrawal mechanics all yours. |

**Critical limitation:** an MoR absorbs tax, invoicing, refunds, withdrawal rights and the consumer contract. It absorbs **none** of your product liability. Under PLD Art. 4(10) you remain the manufacturer, and Art. 15 says that can't be shifted by contract.

### 4.9 Insurance — probably not worth it, but get one quote

Norwegian *profesjonsansvarsforsikring* usefully covers *"formueskade, personskade eller tingskade"* — it reaches personal injury, not just economic loss. Realistic pricing for a one-person near-zero-turnover operation: **NOK 3,000–10,000/year**, which likely exceeds your revenue. Two catches: most policies presuppose a registered business (cutting against the stay-a-hobbyist strategy), and underwriters may specifically exclude bodily injury from use of the advice — the exact risk you'd be buying it for.

⚖️ Get one quote with an honest description. **The quote is diagnostic:** if underwriters price it high or decline, that tells you something the statutes don't.

---

## 5. The money: what you'd actually make

**Current annual cost: ~$15–20** (domain only). GitHub Pages is free. Firestore's Spark tier — 1 GiB stored, 50k reads/day, 20k writes/day — will comfortably absorb thousands of hobbyist users of a local-first app that syncs occasionally.

**Your stated goal is already met.** There is nothing to recover.

If you sell anyway, realistic year-one volumes assuming a good launch across all channels and zero marketing spend:

*Reach:* Hacker News front page (~8,000 visitors, ~2% triathlete overlap → ~160 qualified) + r/triathlon and a Slowtwitch thread (~2,000–4,000 qualified) + Product Hunt non-featured (~300 visitors, near-zero qualified) + negligible year-one SEO against Garmin and TrainingPeaks. **Call it 3,000–5,000 genuinely qualified triathlete visitors.**

*Then the gates compound:*
1. Wants a planner at all, given Garmin Coach and Intervals.icu are free: **~15%** → 450–750
2. Will pay upfront to an unknown solo dev, no trial: **~10%** → 45–75
3. **Has or will create an API key:** **~30%** of those (generous — self-selection helps) → **14–23**

| Scenario | Units | @ $39 | @ $59 |
|---|---|---|---|
| Pessimistic | 5–15 | $195–585 | $295–885 |
| **Base case** | **20–50** | **$780–1,950** | **$1,180–2,950** |
| Optimistic (HN front page + Reddit hit) | 75–150 | $2,925–5,850 | $4,425–8,850 |
| DC Rainmaker mention (lottery ticket) | 300–800 | — | $17,700–47,200 |

**Base case: 20–50 units, roughly $800–3,000 gross, minus ~7–12% MoR fees, minus your time.** Call it one to two weekends of consulting income — in exchange for a multi-year support obligation to 20–50 strangers, CRA reporting duties, and the consumer-law surface in §4.5.

On distribution: **DC Rainmaker** (1M+ monthly uniques, the paper of record) would outweigh every other channel combined — but he receives *"2–3 emails per week"* about new training platforms and covers approximately none. Treat it as a lottery ticket, not a plan. **Hacker News** would love "single-file vanilla JS, no build step, local-first, BYOK" and would supply almost no triathletes — expect upvotes and a long thread about localStorage key security, not sales.

---

## 6. What I'd actually recommend

Three options, in the order I'd rank them for *your* stated goal.

### Option A — Free, with a tip jar (recommended)

Keep yootri free and open. Add a **$20–25 one-time "supporter" purchase** through Gumroad that buys early access to new plan templates and a name in the credits — **not the software**.

This is exactly Obsidian's Catalyst model, and exactly what Intervals.icu proved works for your builder profile in your sport. Structurally it is still a one-time fee; legally it is not a promise of software conformity, which sidesteps most of §4.5. And if you open-source it and keep the supporter tier genuinely separate from the product, you have a real argument for the **PLD Art. 2(2) FOSS carve-out** and the **CRA's non-commercial exclusion** — the two heaviest items in the whole register.

Cost recovery: achieved. Legal surface: minimal. Support obligation: goodwill, not statute.

### Option B — Sell it, but fix the three things that break it

If you want the experience of shipping a commercial product — a legitimate reason on its own — then:

1. **Drop BYOK as the only path.** Ship a mode that works with **no AI at all**. The planner, the load chart, the periodisation, the stock plans — that's a complete $39 product. Make the AI coach an optional power-user feature, clearly labelled as requiring your own API key. This alone roughly triples your addressable buyers.
2. **Never say "perpetual" or "lifetime."** Sell *"includes 2 years of updates; your version keeps working forever,"* disclosed pre-purchase. Sublime Text's exact structure.
3. **Price at $39–49**, anchored to the **plan** band ($25–75), not the software band. $99+ competes with Athletica's full year at $189 and loses on trust.

Plus: Gumroad or Paddle as MoR, the warning stack in §7, an Art. 50 label on the coach, and localStorage-only by default with opt-in sync.

### Option C — Keep it private

Entirely defensible. It's a good tool built for you, it costs $15/year, and every legal item above evaporates. The only thing you'd lose is the fun of shipping — which is a real thing to want, and Option A gives you most of it.

---

## 7. Copy and terms: what to write

### Marketing copy — the MDR discipline

**Use:** train, training, performance, planning, periodisation, training load, session, volume, race preparation.

**Never use:** injury prevention, injury risk, overtraining detection, readiness, recovery monitoring, health monitoring, medically validated, clinically proven, doctor-designed, physiotherapist, ernæringsfysiolog, medisinsk. **No CE mark.**

Every performance claim must be substantiable on request under markedsføringsloven § 7 — the burden is on you. "Plan your season" is safe. "Get 12% faster" is not.

### The intended-purpose statement (put this in the terms and the README)

> yootri is a training planning and logging tool for recreational endurance athletes. It is intended for lifestyle, fitness and sports-performance purposes only. It is not intended to diagnose, prevent, monitor, predict, treat or alleviate any disease, injury or medical condition, and it is not a medical device.

### The warning stack (adapt — ⚖️ have a Norwegian lawyer review before you charge money)

> **Not medical or professional advice.** yootri is not a substitute for advice from your physician, physiotherapist, or a qualified coach. Never disregard or delay seeking medical advice because of anything in this application.
>
> **The developer is not a certified coach, personal trainer, or medical professional.** yootri is software, not a coaching service, and no coaching relationship is created by using it.
>
> **Consult a physician before beginning any training programme**, particularly if you have or have had any cardiac condition, dizziness or balance problems, bone or joint problems, or any condition that exercise could worsen. By using yootri you confirm either that you have no such condition, or that a physician has approved your participation.
>
> **Assumption of risk.** Endurance training carries inherent and significant risks of injury, illness and death. Your use of yootri — **including following, adapting, or acting on any training plan, session, or recommendation it generates** — is at your own risk. You are solely responsible for your own training decisions.
>
> **AI-generated content.** Where you connect your own AI provider, coaching responses are generated by an artificial intelligence model, not a human coach. AI output may be inaccurate, inappropriate for your circumstances, or simply wrong. Review it critically and do not follow it without your own judgement.
>
> **No warranty as to results.** yootri makes no guarantee of fitness improvement, race outcome, or any other result.
>
> **Savings clause.** Nothing in these terms excludes or limits liability where such exclusion is not permitted by law, including liability for death or personal injury where applicable law does not allow it. If you live in a jurisdiction that does not allow certain of these exclusions or limitations, they do not apply to you.

Note what that last clause is doing: it's not weakness, it's what every competent set of consumer terms includes, and it stops the whole section being read as an abusive term under avtaleloven § 36.

### The system prompt is a compliance artifact

Constrain the LLM to refuse medical and diagnostic questions and redirect to a doctor. **Version it, keep it, and treat changes to it as seriously as changes to your terms** — it is part of your intended purpose, and it is evidence of reasonable care under a negligence analysis.

### At first interaction with the coach (AI Act Art. 50)

> Responses in this panel are generated by an AI model using the API key you configured. This is not advice from a human coach.

---

## 8. If you proceed — checklist

**Before writing any sales copy**
- [ ] Audit every user-facing string, README line and system prompt against the §7 word lists
- [ ] Write the intended-purpose statement and put it where a regulator would look first
- [ ] Free enquiry to DMP / the tverretatlig veiledningstjeneste if you're unsure about any feature

**Before taking money**
- [ ] Pick an MoR (Gumroad for speed, Paddle for polish) — do **not** use bare Stripe/PayPal
- [ ] ⚖️ Norwegian lawyer reviews the terms — the update obligation and the withdrawal waiver are the parts worth paying for
- [ ] State a bounded update period pre-purchase; delete "perpetual" and "lifetime"
- [ ] Confirm the checkout button reads "order with obligation to pay" or equivalent
- [ ] Pre-contractual info: real geographical address, total price incl. tax, browser requirements, that an AI API key is required, that data is stored locally
- [ ] Peloton-style health attestation at first run
- [ ] Art. 50 AI label on the coach panel
- [ ] Decide on Firestore sync: drop it, or explicit separate Art. 9 consent + DPA + EU region + privacy notice naming the LLM transfer

**Ongoing**
- [ ] ⚖️ Understand your CRA position before 11 September 2026 — vulnerability handling, SBOM, 24-hour reporting
- [ ] Get one insurance quote; read the exclusions before paying
- [ ] Watch NOK 50,000 rolling turnover for MVA
- [ ] Keep a dated archive of your terms and system prompts

---

## 9. Where you genuinely need a lawyer

1. **How long the digitalytelsesloven update obligation runs** for your product and price point — the most consequential open question, unresolvable from public sources.
2. **Whether the Cyber Resilience Act reaches a browser-only app calling a third-party API**, and what minimum compliance looks like for a solo dev. Highest practical burden on the list.
3. **Reviewing final marketing copy against the MDR intended-purpose line** — cheap review, catastrophic downside if wrong.
4. **Any decision to add HRV, readiness, recovery or injury-risk features.** That is the moment the MDR analysis genuinely changes. Ask *before* writing the code.
5. **The Norwegian implementation of PLD 2024/2853** once the EEA Joint Committee acts, including whether Norway disapplies the development-risk defence.

**Explicitly unsettled, flagged as such:** the MDR treatment of injury-prevention and readiness claims (no MDCG example on point); whether AI Act Art. 50(2) synthetic-content marking reaches an in-app assistant; whether an LLM feature inside a non-medical app is assessed as a separate "module" under MDCG 2019-11 Rev.1; and the exact date Norwegian AI rules bind you.

---

## Closing note

You asked whether the lack of a coaching certification is a legal problem. **It isn't** — no title protection, no licensure, and the fitness/wellness carve-out from MDR is explicit and names *trening* directly. The risk was never your credentials; it's what you write on the landing page and whether you use the word "perpetual."

The harder finding is commercial, and it's not about the code — the code is good. It's that your differentiator (BYO-key, no subscription) rests on a premise that doesn't hold: your buyers' AI subscriptions can't be used, so they'd pay *more*, not less. And the market you'd enter just had its floor set to free by Garmin.

Given that your actual goal is cost recovery on a project you're already running for €15/year, **Option A — free, open, with a supporter tier — gets you the shipping experience, a real chance at the Intervals.icu outcome, and it deletes the two heaviest legal items (CRA and PLD) rather than managing them.**

---

## Sources

**Medical device / MDR**
[MDCG 2019-11 Rev.1 (June 2025)](https://health.ec.europa.eu/document/download/b45335c5-1679-4c71-a91c-fc7a4d37f12b_en?filename=mdcg_2019_11_en.pdf) · [EC announcement of Rev.1](https://health.ec.europa.eu/latest-updates/update-mdcg-2019-11-rev1-qualification-and-classification-software-regulation-eu-2017745-and-2025-06-17_en) · [MDR full text (EUR-Lex)](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX%3A32017R0745) · [MDR Art. 2 definitions](https://www.medical-device-regulation.eu/2019/07/10/mdr-article-2-definitions/) · [Johner Institute on Rule 11](https://blog.johner-institute.com/regulatory-affairs/mdr-rule-11/) · [Bristows on Rule 11](https://www.bristows.com/news/deciphering-rule-11-new-guidance-on-the-classification-of-software-medical-devices-under-the-eu-mdr/) · [Emergo by UL on Rev.1](https://www.emergobyul.com/news/european-revision-primary-software-guidance-mdcg-2019-11-revision-1-small-changes-meaningful) · [DMP MDSW webinar 05.11.2025](https://www.dmp.no/globalassets/documents/medisinsk-utstyr/webinar-og-seminar/mdsw-webinar-host-2025---korrigert.pdf) · [DMP — Programvare som medisinsk utstyr](https://www.dmp.no/medisinsk-utstyr/utvikling-og-produksjon/programvare-som-medisinsk-utstyr) · [DMP — Kvalifisering](https://www.dmp.no/medisinsk-utstyr/utvikling-og-produksjon/kvalifisering-og-klassifisering/kvalifisering) · [Forskrift om medisinsk utstyr](https://lovdata.no/dokument/SF/forskrift/2021-05-09-1476) · [Tverretatlig veiledningstjeneste](https://www.helsedirektoratet.no/digitalisering-og-e-helse/kunstig-intelligens/tverretatlig-veiledningstjeneste) · [FDA — apps that are not medical devices](https://www.fda.gov/medical-devices/device-software-functions-including-mobile-medical-applications/examples-mobile-apps-are-not-medical-devices)

**AI Act**
[Art. 50 (transparency)](https://artificialintelligenceact.eu/article/50/) · [Art. 3 (definitions)](https://artificialintelligenceact.eu/article/3/) · [Annex III](https://artificialintelligenceact.eu/annex/3/) · [Art. 99 (penalties)](https://artificialintelligenceact.eu/article/99/) · [Regulation (EU) 2026/1744 in the OJ](https://www.nicfab.eu/en/posts/digital-omnibus-ai-official-journal/) · [Orrick — Digital Omnibus finalizes 8 changes](https://www.orrick.com/en/Insights/2026/07/EU-AI-Act-Update-Digital-Omnibus-Finalizes-8-Compliance-Changes) · [Commission GPAI guidelines FAQ](https://digital-strategy.ec.europa.eu/en/faqs/guidelines-obligations-general-purpose-ai-providers) · [Commission Art. 50 transparency guidelines](https://digital-strategy.ec.europa.eu/en/policies/guidelines-transparency-ai-generated-content) · [regjeringen.no — KI-loven på ny høring (4 Aug 2026)](https://www.regjeringen.no/no/aktuelt/tung-vil-sende-ki-loven-med-endringer-pa-horing/id3169693/) · [kiforordning.no — status i Norge](https://kiforordning.no/ki-loven-norge/)

**Liability, consumer law, CRA**
[Directive (EU) 2024/2853 (new PLD)](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX%3A32024L2853) · [Gibson Dunn on the PLD](https://www.gibsondunn.com/eu-product-liability-directive-responding-to-software-ai-and-complex-supply-chains/) · [Taylor Wessing on the PLD](https://www.taylorwessing.com/en/insights-and-events/insights/2025/01/di-new-product-liability-directive) · [EFTA EEA-Lex 32024L2853](https://www.efta.int/eea-lex/32024l2853) · [Produktansvaret (Jusinfo)](https://jusinfo.no/erstatningsrett/produktansvar/produktansvaret/) · [Wikborg Rein — AI og ansvar](https://www.wr.no/aktuelt/hvem-er-ansvarlig-nar-bruk-av-ai-leder-til-skade) · [Directive 93/13/EEC Annex](https://www.legislation.gov.uk/eudr/1993/13/annex) · [Avtaleloven § 36](https://www.obiterdictum.org/artikkel/avtaleloven-36-en-introduksjon) · [Digitalytelsesloven](https://lovdata.no/lov/2022-06-17-56) · [Forbrukertilsynet on digitalytelsesloven](https://www.forbrukertilsynet.no/vi-jobber-med/digitalytelsesloven) · [Directive (EU) 2019/770](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:32019L0770) · [Directive 2011/83/EU (CRD)](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX%3A32011L0083) · [Angrerettloven ch. 6](https://lovdata.no/dokument/NL/lov/2014-06-20-27/KAPITTEL_6) · [Cyber Resilience Act explained](https://www.cyberresilienceact.eu/explained.html) · [European Commission — CRA](https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act) · [Crowell — CRA 11 Sept 2026 deadline](https://www.crowell.com/en/insights/client-alerts/eu-cyber-resilience-act-countdown-11-september-2026-incidentvulnerability-reporting-deadline-is-less-than-100-days-away) · [Winter v. G.P. Putnam's Sons](https://law.justia.com/cases/federal/appellate-courts/F2/938/1033/294363/) · [Garcia v. Character Technologies ruling](https://www.transparencycoalition.ai/news/important-early-ruling-in-characterai-case-this-chatbot-is-a-product-not-speech) · [Raine v. OpenAI](https://lawsuitinformer.com/raine-v-openai-lawsuit)

**Incumbent terms**
[TrainingPeaks Terms of Use](https://www.trainingpeaks.com/terms-of-use/) · [Strava Terms of Service](https://www.strava.com/legal/terms) · [Whoop Terms of Use](https://www.whoop.com/us/en/termsofuse/) · [Peloton Terms of Service](https://onepeloton.com/terms-of-service)

**Marketing, titles, GDPR**
[Forbrukertilsynet — mfl. § 7](https://www.forbrukertilsynet.no/veileder-om-de-generelle-kravene-i-markedsforingsloven/markedsforingsloven-forbudet-mot-villedende-handlinger) · [UCPD Annex I blacklist](https://www.ippt.eu/legal-texts/unfair-commercial-practices-directive/unfair-commercial-practices-directive-21) · [SNL — personlig trener (title not protected)](https://snl.no/personlig_trener_-_PT) · [Art29WP — health data in apps and devices](https://ec.europa.eu/justice/article-29/documentation/other-document/files/2015/20150205_letter_art29wp_ec_health_data_after_plenary_annex_en.pdf) · [Datatilsynet — særlige kategorier](https://www.datatilsynet.no/rettigheter-og-plikter/virksomhetenes-plikter/om-behandlingsgrunnlag/spesielt-om-sarlige-kategorier-av-personopplysninger/) · [Firebase DPA terms](https://firebase.google.com/terms/data-processing-terms)

**Tax, VAT, merchant of record**
[Skatteetaten — kravet til næringsvirksomhet](https://www.skatteetaten.no/en/rettskilder/type/handboker/merverdiavgiftshandboken/2022/M-2/M-2-1/M-2-1.4/) · [Fiken — MVA-registrering 2026](https://blogg.fiken.no/registrering-i-merverdiavgiftsregisteret/) · [Skatteetaten — mval. § 6-22](https://www.skatteetaten.no/en/rettskilder/type/handboker/merverdiavgiftshandboken/gjeldende/M-6/M-6-22/M-6-22.4/) · [Your Europe — One Stop Shop](https://europa.eu/youreurope/business/taxation/vat/one-stop-shop/index_en.htm) · [AVASK — VAT for digital services 2026](https://avask.com/blog/vat-for-digital-services/) · [Paddle pricing](https://www.paddle.com/pricing) · [Paddle Buyer Terms](https://www.paddle.com/legal/checkout-buyer-terms) · [Gumroad pricing](https://gumroad.com/pricing) · [Stripe Managed Payments](https://stripe.com/managed-payments) · [If — profesjonsansvarsforsikring](https://www.if.no/bedrift/forsikring-for-bedrifter/ansvarsforsikring/profesjonsansvarsforsikring)

**Market**
[TrainingPeaks pricing](https://www.trainingpeaks.com/pricing/for-athletes/) · [Garmin/TrainingPeaks acquisition, July 2026](https://the5krunner.com/2026/07/22/garmin-trainingpeaks-acquisition-price/) · [Garmin Coach adaptive plans](https://garminrumors.com/overview-of-garmin-coach-plans-adaptive-training-plans-for-every-athlete/) · [Intervals.icu pricing](https://www.intervals.icu/pricing/) · [Intervals.icu review — 160k athletes](https://coachbox.app/en/compare/intervals-icu-review/) · [Today's Plan closure (DC Rainmaker)](https://www.dcrainmaker.com/2023/12/todays-announces-closure.html) · [220 Triathlon — best training apps 2026](https://www.220triathlon.com/gear/tri-tech/best-triathlon-training-apps-review) · [TriDot pricing](https://tridot.com/pricing) · [Humango pricing](https://humango.ai/faqs) · [Athletica pricing](https://athletica.ai/pricing) · [WKO5](https://www.trainingpeaks.com/wko5/) · [Scientific Triathlon plans](https://scientifictriathlon.com/plans/) · [MyProCoach free 70.3 plans](https://www.myprocoach.net/free-training-plans/half-ironman-70-3/) · [Ironman record registrations 2025](https://www.sgieurope.com/consumer/ironman-reports-record-registrations-in-2025/118716.article) · [USA Triathlon 2025 Impact Report](https://www.usatriathlon.org/news/2026/february/04/usa-triathlon-releases-2025-impact-report-highlighting-strategic-growth-membership-event-momentum-and-progress-toward-la28) · [Ironman participation & barriers (Slowtwitch)](https://slowtwitch.com/industry/digging-into-ironmans-data-on-participation-and-barriers-to-entry/) · [Sublime Text sales FAQ](https://www.sublimehq.com/sales_faq) · [Obsidian pricing / Catalyst](https://obsidian.md/pricing) · [OpenAI API key safety policy](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) · [anthropic-dangerous-direct-browser-access](https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/) · [ChatGPT Plus does not include API access](https://folding-sky.com/blog/why-use-api-keys-not-chatgpt) · [2% of US households pay for AI subscriptions](https://www.cbsnews.com/news/generative-ai-subscriptions-consumer-spending/) · [Raycast Bring Your Own Keys](https://manual.raycast.com/ai/bring-your-own-keys) · [HN front page traffic stats](https://marcotm.com/articles/stats-of-being-on-the-hacker-news-front-page/) · [Product Hunt launch statistics 2026](https://www.shno.co/marketing-statistics/product-hunt-launch-statistics) · [Firebase pricing](https://firebase.google.com/pricing)
