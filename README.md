# Naver SmartStore Product Scraper API

## REST API service that retrieves raw product data from Naver SmartStore using real Chromium automation via Playwright.

The service extracts:
- Product Details JSON
- Benefits JSON

Raw API responses are returned without modification.


## Setup

### Requirements
- Node.js 18+
- npm
- Playwright

### Installation

npm install
npx playwright install chromium



## Environment

Create a .env file:

```bash
PORT=3000
WORKERS=1
HEADLESS=false
JOB_TTL_MS=3600000
PROXIES=http://user:pass@ip:port,http://user:pass@ip:port
```
### Variables
- PORT – server port
- WORKERS – number of parallel browser workers
- HEADLESS=false – required if manual captcha solving is needed
- JOB_TTL_MS – how long completed jobs are kept in memory
- PROXIES – comma-separated list of proxies


## Run

```bash
node server.js
```


## API

Start Scraping
```bash
GET /naver?productUrl=<url>
```
Response:
```bash
{
  "jobId": "uuid"
}
```


## Check Job Status

```bash
GET /naver/jobs/:jobId
```
Possible statuses:
- queued
- running
- needs_manual
- done
- error


## Data Extraction

Product Details

Captured from:

```bash
/i/v2/channels/{channelUid}/products/{productId}?withWindow=false
```
Returned as:
```bash
result.apis.productDetails.json
```
The full raw JSON structure is preserved.


## Benefits APIs

Primary Endpoint

```bash
/i/v2/channels/{channelUid}/benefits/by-products/{productNo}?categoryId={categoryId}
```

Fallback Endpoint
```bash
/i/v2/channels/{channelUid}/product-benefits/{productId}
```
Returned as:
```bash
result.apis.benefits.json
```
Raw JSON is preserved exactly as received.


## Difference Between Benefits APIs

During network analysis of the product page, two distinct benefits-related endpoints were identified.

1. `/benefits/by-products/{productNo}`
- Requires productNo
- Requires categoryId
- Returns structured benefit data tied to product grouping
- Appears to be a more structured endpoint
- Not always triggered automatically on every product page load


2. `/product-benefits/{productId}`
- Uses productId
- Triggered directly during page rendering
- More consistently observed in browser traffic

The APIs are not identical.
- benefits/by-products is category-aware and depends on additional parameters.
- product-benefits is page-render driven and sometimes more permissive.

Both return benefit-related information but originate from different backend flows.


## Fallback Logic

Network inspection showed that:
- In some sessions, benefits/by-products returned valid data.
- In others, only product-benefits was triggered.
- Occasionally, benefits/by-products returned 429 while product-benefits succeeded.

Because of this inconsistency, the system:
	1.	Attempts benefits/by-products first.
	2.	Falls back to product-benefits if the primary endpoint fails.

This improves reliability while:
- Preserving raw API responses
- Avoiding silent data loss

No response transformation is performed.


## Architecture
- Express REST API
- Async job-based processing
- Worker pool using Playwright
- Proxy support with rotation per worker
- Request throttling and random delays
- Retry logic for API calls
- Worker restart isolation
- Manual captcha handling support


## Design Rationale

Navigation Flow

Direct access to product page URLs or internal JSON APIs frequently resulted in:
- HTTP 429 responses
- Verification pages
- Captcha challenges

Network behavior analysis showed that navigating via:

`naver.com → search store → open SmartStore → open product`

resulted in more stable sessions compared to direct product page requests.

This approach mimics normal user interaction and reduces immediate blocking risk.
The scraping flow was designed accordingly.


## Captcha and Scaling Constraints

Manual captcha solving is sometimes required.

This limits horizontal scalability because:
- A worker may pause until manual verification is completed.
- Fully automated scaling is not possible without a captcha-handling solution.

The architecture was designed so that scaling becomes straightforward once captcha solving is automated.


## Scaling Strategy

The system is structured with scalability in mind:
- Workers are independent
- Proxy assignment is isolated per worker
- Jobs are asynchronous
- Concurrency is configurable via WORKERS
- Worker restart logic isolates failures
- API layer is decoupled from scraping logic

To scale for higher traffic:
	1.	Run multiple service instances behind a load balancer.
	2.	Replace in-memory job storage with Redis or another distributed queue.
	3.	Add response caching for repeated product URLs.
	4.	Use stable proxy infrastructure.
	5.	Integrate automated captcha solving if available.


## Current Limitations
- Manual captcha solving required
- In-memory job storage
- Single-node deployment
- No distributed queue

Due to resource constraints, a fully automated captcha bypass and distributed infrastructure were not implemented.

With additional infrastructure and team resources, this architecture can be extended to support stable high-volume scraping under controlled conditions.
