# StewardEx / Charity Compliance — Infrastructure Cost Estimate

> **Researched estimate** built on exact AWS Asia Pacific (Sydney, `ap-southeast-2`)
> list prices, May 2026. Multi-tenant backend on EC2 `c7i` + Auto Scaling Group,
> shared MongoDB Atlas, frontend on Vercel (free tier), domain already owned.
>
> **Prepared:** 2026-05-21 · **Currency:** AUD (AWS bills USD; 1 USD = 1.53 AUD).

---

## 1. Cost by growth band

Monthly infrastructure cost (AUD), at the upper end of each band:

| Tenants | Servers | Database | Other AWS | **Total / month** | Cost per tenant |
|---|--:|--:|--:|--:|--:|
| 1 | A$260 | A$121 | A$69 | **A$450** | A$450 |
| 2 – 5 | A$260 | A$121 | A$109 | **A$490** | A$98 |
| 5 – 15 | A$520 | A$121 | A$274 | **A$915** | A$61 |
| 15 – 50 | A$780 | A$300 | A$810 | **A$1,890** | A$38 |
| 50 – 75 | A$1,040 | A$300 | A$1,200 | **A$2,540** | A$34 |
| 75 – 100 | A$1,222 | A$782 | A$1,376 | **A$3,380** | A$34 |

Total cost rises with tenants (A$450 → A$3,380); cost **per tenant** falls then
**settles around A$34** — it does not collapse to near-zero, because every tenant
still consumes real storage, data traffic and server time.

**What changes at each band:**
- **1** — one `c7i.xlarge` + entry database (Atlas M10). Full platform live.
- **2–5** — same single server; only storage/traffic grows.
- **5–15** — 2nd server added for high availability (zero-downtime updates, failover).
- **15–50** — database upgraded M10→M20; ASG auto-scales to 3 servers.
- **50–75** — 4th server added; data traffic becomes a larger share of the bill.
- **75–100** — 5-server fleet + larger database (M30) for the heavier load.

---

## 2. Per-tenant cost varies — it is a blended average

**A$34 is the typical blended figure.** The real cost of serving one charity depends on:

- **Size of the organisation** — more staff/board users → more accounts, documents and
  activity. A small charity (5–10 users) costs far less than a large one (100+ users).
- **Incoming traffic & activity** — frequent logins, report generation and file
  uploads/downloads all consume server time and data transfer.

| Charity profile | Typical cost / month |
|---|--:|
| Small, light usage (5–10 users) | ~A$20 |
| Mid-size, moderate activity | ~A$35 |
| Large, highly active (100+ users) | A$70 – A$90 |

The band table above assumes a mixed customer base averaging ~A$34/tenant at scale.

---

## 3. Recommended server: EC2 `c7i.xlarge`

**4 vCPU · 8 GiB RAM · A$0.357/hr (US$0.2331) → ~A$260/month** (~A$187/mo on a 1-yr plan).

The backend runs the Express API, Socket.io websockets, and **Puppeteer headless-Chrome
PDF generation**. PDF generation is the heaviest task — each render briefly uses a full
core and 350–500 MB RAM. Sizing is driven by that.

| Option | Size | A$/mo | Verdict |
|---|---|--:|---|
| `c7i.large` | 2 vCPU / 4 GiB | A$130 | ❌ Too small — Node + OS leave room for only 1–2 PDF renders; OOM risk. |
| **`c7i.xlarge`** | **4 vCPU / 8 GiB** | **A$260** | ✅ **Recommended** — runs API + websockets + 4–6 concurrent PDFs. Right from launch to 100+ tenants. |
| `c7i.2xlarge` | 8 vCPU / 16 GiB | A$521 | Only needed beyond ~150–200 tenants. |

### Auto Scaling Group

| Stage | min / desired / max | Purpose |
|---|---|---|
| 1–10 tenants | 1 / 1 / 2 | Single server — lean launch |
| 10–50 tenants | 2 / 2–3 / 4 | 2+ servers across AZs — zero-downtime / failover |
| 50–100 tenants | 3 / 4–5 / 6 | Auto-adds capacity at peak |

Scale-out trigger: target tracking at 60% CPU. Off-peak hours scale back in.

---

## 4. Exact prices used (AWS Sydney `ap-southeast-2`, May 2026)

AWS bills in USD; AUD column uses 1 USD = 1.53 AUD.

| Service | Rate (USD) | Rate (AUD) | Monthly |
|---|---|---|---|
| EC2 `c7i.large` | $0.1166 / hr | A$0.178 / hr | A$130 |
| EC2 `c7i.xlarge` | $0.2331 / hr | A$0.357 / hr | A$260 |
| EC2 `c7i.2xlarge` | $0.4662 / hr | A$0.713 / hr | A$521 |
| MongoDB Atlas M10 | ~$79 / mo | — | ~A$121 |
| MongoDB Atlas M20 | ~$196 / mo | — | ~A$300 |
| MongoDB Atlas M30 | ~$511 / mo | — | ~A$782 |
| EBS gp3 | $0.096 / GB-mo | A$0.147 / GB-mo | per volume |
| Application Load Balancer | ~$0.025 / hr + LCU | A$0.038 / hr | ~A$28 + usage |
| S3 Standard | $0.025 / GB-mo | A$0.038 / GB-mo | per usage |
| Data transfer out | first 100 GB free, then $0.114 / GB | A$0.174 / GB | per usage |

**Sources:** aws-pricing.com (exact c7i Sydney rates), mongodb.com/pricing (Atlas
tier rates), aws.amazon.com EC2/S3/EBS pricing pages.

---

## 5. Component detail per band (AUD/month)

| Component | 1 | 2–5 | 5–15 | 15–50 | 50–75 | 75–100 |
|---|--:|--:|--:|--:|--:|--:|
| EC2 (`c7i.xlarge`, avg running) | 260 | 260 | 520 | 780 | 1,040 | 1,222 |
| MongoDB Atlas | 121 (M10) | 121 (M10) | 121 (M10) | 300 (M20) | 300 (M20) | 782 (M30) |
| EBS gp3 disks | 7 | 7 | 15 | 22 | 29 | 37 |
| Application Load Balancer | 32 | 35 | 42 | 60 | 76 | 90 |
| S3 file storage | 5 | 9 | 21 | 58 | 85 | 95 |
| Data transfer out | 5 | 26 | 141 | 540 | 820 | 924 |
| CloudWatch / SES / Route 53 | 20 | 32 | 55 | 130 | 190 | 230 |
| **Total** | **A$450** | **A$490** | **A$915** | **A$1,890** | **A$2,540** | **A$3,380** |

> Data transfer is the fastest-growing line — it scales directly with how heavily
> charities log in, generate reports and download files.

---

## 6. Costs shown separately (not infrastructure)

- **Stripe** — ~1.7% + A$0.30 per charge (AU domestic). Charged only on income actually
  received; scales with revenue, not servers.
- **OpenAI** — AI compliance assistant, pay-as-you-go. ~A$30–45/mo at launch, rising
  with usage.

---

## 7. Cost levers

| Lever | Effect |
|---|---|
| 1-year EC2 Savings Plan | −~28% on the server bill (A$260 → ~A$187/instance) |
| 3-year EC2 commitment | −~45–50% on the server bill |
| Deploy in `us-east-1` instead of Sydney | EC2 −~24%, Atlas −~25% — but loses AU data residency |
| S3 lifecycle → Infrequent Access for old files | −~40% on cold storage |
| CloudFront caching in front of the API | reduces data-transfer cost at scale |

---

## 8. Free / already covered — A$0

- **Vercel** — frontend hosting on the free tier.
- **Domain** — already purchased.
- **SSL certificates** — AWS Certificate Manager, free.
- **Secrets / config** — AWS SSM Parameter Store, free.

---

*Researched planning estimate — not a quote. AWS Sydney list prices, May 2026.
Per-tenant cost varies with organisation size and traffic. Excludes staff wages,
marketing and office overheads. Verify against the
[AWS Pricing Calculator](https://calculator.aws/) before financial commitment.*
