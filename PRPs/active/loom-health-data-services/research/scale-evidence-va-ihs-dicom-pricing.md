# Scale evidence for a VA/IHS-wide health data platform: VA, IHS, DICOM, FHIR, Azure prices and limits

Retrieved 2026-10-22. All figures carry the publication year of the source. Confidence:
**CITED** = figure read directly from the linked primary/secondary page (or from the Azure
Retail Prices API, which is Microsoft's public list-price feed). **UNVERIFIED** = reported
only via a search-engine snippet or a third-party aggregator and not re-read from the
source. **ASSUMPTION** = derived by arithmetic from cited inputs; the arithmetic is shown.
No PHI. Azure prices are USD list (pay-as-you-go), region named per row.

How the Azure prices were obtained: `GET https://prices.azure.com/api/retail/prices?$filter=...`
with `armRegionName eq 'usgovvirginia'` (Gov) or `'eastus'` (Commercial) and
`priceType eq 'Consumption'`, on 2026-10-22. The `effectiveStartDate` of each meter is given as the
year. Interactive pricing pages (azure.microsoft.com/pricing) were not fetchable; the API is the
same data those pages render.

---

## A. VA / VHA

| figure | value | year | source URL | confidence |
|---|---|---|---|---|
| Enrolled Veterans | "over 9.1 million Veterans enrolled in the VA health care program" | 2025 (page current) | https://department.va.gov/vha/about-us/ | CITED |
| Enrolled Veterans (budget row) | "Unique Veterans Enrolled in VA Health Care 9,219,062 (2025 enacted) / 9,302,164 (2026) / 9,389,052 (2027 request) / 9,477,264 (2028 advance)" | 2026 (FY2027 BiB) | https://department.va.gov/wp-content/uploads/2026/04/2027-BiB.pdf | CITED |
| Unique patients treated | "Unique Patients 7,665,003 (2025) / 7,887,814 (2026) / 8,122,481 (2027) / 8,356,921 (2028)" | 2026 (FY2027 BiB) | https://department.va.gov/wp-content/uploads/2026/04/2027-BiB.pdf | CITED |
| Unique patients, FY2024 actual | "7.33 million patients and 145.2 million visits" (2024 published figures, per FY2026 BiB) | 2025 | https://www.federalhiringdata.com/articles/va-health-workforce-care-demand-2026 (secondary, citing VA FY2026 BiB) | UNVERIFIED |
| Outpatient visits | "Outpatient Visits 154,507,000 (2025) / 161,505,000 (2026) / 169,916,000 (2027) / 179,373,000 (2028)" | 2026 (FY2027 BiB) | https://department.va.gov/wp-content/uploads/2026/04/2027-BiB.pdf | CITED |
| Outpatient visits, FY2023/FY2024 estimates | "137.9 million visits in FY2023 to 139.7 million visits in FY2024" | 2024 (CRS R48056) | https://www.congress.gov/crs-product/R48056 | UNVERIFIED (snippet) |
| Inpatients treated | "Inpatient-Treated 1,248,714 (2025) / 1,332,183 (2026) / 1,408,325 (2027) / 1,478,991 (2028)" | 2026 (FY2027 BiB) | https://department.va.gov/wp-content/uploads/2026/04/2027-BiB.pdf | CITED |
| Clinical encounters by channel | "more than 115 million clinical encounters ... roughly 40 million in-person appointments and more than 31 million telehealth and telephone appointments and approximately 38 million community care appointments" | 2023 (FY2024 Vol II) | https://www.va.gov/budget/docs/summary/fy2024-va-budget-volume-ii-medical-programs.pdf | UNVERIFIED (snippet) |
| Facilities | "1,380 health care facilities, including 170 VA Medical Centers and 1,193 outpatient sites of care" | 2025 | https://department.va.gov/vha/about-us/ and https://www.va.gov/health/index.asp | CITED |
| Facilities (end FY2025) | "At the end of 2025, the VHA system included 172 medical centers and nearly 1,200 outpatient clinics" | 2026 (FY2027 BiB) | https://department.va.gov/wp-content/uploads/2026/04/2027-BiB.pdf | CITED |
| VISNs | "18 geographical administrative areas called Veterans Integrated Services Networks (VISNs)" | 2026 (2025 enrollee survey report) | https://department.va.gov/vha/wp-content/uploads/sites/65/2026/07/2025-Survey-of-Veteran-Enrollees-Findings-Report_Final_.pdf | UNVERIFIED (snippet) |
| Employees | "more than 371,000 health care professionals and support staff" | 2025 | https://department.va.gov/vha/about-us/ | CITED |
| VistA instances | "customization of the system by local facilities has resulted in about 130 clinical versions of VistA—referred to as instances"; "operated from four regional VA data centers" | 2019 (GAO-19-125), repeated 2022 (GAO-22-103718) | https://www.gao.gov/assets/gao-19-125.pdf ; https://www.gao.gov/assets/gao-22-103718.pdf | UNVERIFIED (snippet) |
| VistA instance copies | "VA currently runs 130 separate VistA Instances ... a separate DR, Test, and VistA Read Only instance that matches each of the 130 operational VistAs, meaning each VistA instance has four copies" | ~2017 (SAM.gov RFI) | https://sam.gov/opp/326e71c24874a08ac4c8897e3eff1722/view | UNVERIFIED (snippet) |
| VistA Imaging total images | "acquired its 10 billionth image" on 2019-08-25 | 2019 (page updated 2023) | https://www.va.gov/health/imaging/ | CITED |
| VistA Imaging annual growth | "A little over a billion images are acquired annually." | 2019/2023 | https://www.va.gov/health/imaging/ | CITED |
| VistA Imaging modalities | "Over 650 different models of DICOM image acquisition instruments send images to VistA." | 2019/2023 | https://www.va.gov/health/imaging/ | CITED |
| VistA Imaging storage (only published PB figure) | "over one billion stored images in January [2009] ... storage space used today is approximately one pedabyte" | 2009 | https://en.wikipedia.org/wiki/VistA_Imaging (quoting VA 2009 release) | UNVERIFIED |
| VistA Imaging storage, extrapolated | ~1 MB/image average (1 PB / 1e9 images, 2009) × 10e9 images (2019) ≈ 10 PB by 2019; +~1e9 images/yr ⇒ ~16–17 PB by 2026 before compression/tiering | — | derived from the two rows above | ASSUMPTION |
| VistA Imaging architecture | "facility level (Tier 1) ... VistA Imaging virtual servers and local storage, and the Remote repository (Tier 2 VAEC AWS)" | 2025 (FY25 PIA) | https://department.va.gov/privacy/wp-content/uploads/sites/5/2025/09/FY25VistAImagingPIA.pdf | UNVERIFIED (snippet) |
| VA radiology exams per year | "10-12 million annual radiology exams performed across VA each year"; NTP "interprets roughly 1.5 million exams per year" | 2025 (FY26 NTP NextGen PACS PIA) | https://department.va.gov/privacy/wp-content/uploads/sites/5/2025/12/FY26NationalTeleradiologyProgramNextGenerationPictureArchiveandCommunicationSystemPIA.pdf (404 on direct fetch; quote from search index) | UNVERIFIED |
| National Teleradiology Program volume | "314,874 stat imaging studies completed in fiscal year 2014 to 1,096,229 in fiscal year 2024"; FY2024 routine 363,820 | 2025 (VA OIG 25-01255-242) | https://www.oversight.gov/sites/default/files/documents/reports/2025-12/VAOIG-25-01255-242-FINAL.pdf | UNVERIFIED (snippet) |
| EHRM sites live | "Six" (five sites Oct 2020–Jun 2022 + Lovell FHCC Mar 2024); "Four Michigan facilities ... followed by nine additional sites in 2026, for 13 total"; "Approximately 170 by 2031" | 2025-12 (GAO-26-108812) | https://files.gao.gov/reports/GAO-26-108812/index.html | CITED |
| EHRM cost | IDA 2022 life-cycle "$49.8 billion: $32.7 billion for 13 years of implementation and $17.1 billion for 15 years of sustainment"; "obligated about $13.84 billion ... FY2018 through Q2 FY2025" | 2025-12 | https://files.gao.gov/reports/GAO-26-108812/index.html | CITED |
| EHRM recommendations | 18 GAO recommendations; 2 fully implemented, 1 partial, 15–16 open | 2025-12 | https://files.gao.gov/reports/GAO-26-108812/index.html | CITED |
| EHRM 2026 progress | "deployed the system to 11 sites in 2026, with Cleveland and Anchorage scheduled to go live in October ... 26 additional site deployments in 2027" | 2026 | https://federalnewsnetwork.com/veterans-affairs/2025/12/va-in-2026-looks-to-get-ehr-rollout-back-on-track-embark-on-health-care-reorganization/ ; https://www.nextgov.com/modernization/2026/08/va-seeks-extend-its-oracle-health-record-contract-through-2031/415380/ | UNVERIFIED (snippet) |
| EHRM users | "more than 29,000 clinicians and front-line employees were using the Federal EHR to serve more than 515,000 Veterans" | 2026 | https://www.healthcaredive.com/news/va-to-roll-out-oracle-ehr-9-additional-sites-2026/741964/ | UNVERIFIED (snippet) |
| CDW size | "corporate data warehouse (CDW), now totaling over 50 terabytes" (undated, likely 2010s) ; VINCI "105 high-performance servers and 1.5 petabytes of data storage" | undated / 2018 | https://va.ornl.gov/about/ ; https://med.stanford.edu/content/dam/sm/s-spire/documents/Administrative-Data-Research-in-the-VHA_3.12.18_Graham.pdf | UNVERIFIED |
| CDW patients | "over 20 million unique patient records" ; OMOP: "approximately 16,927 thousand unique patients" | 2014 / OHDSI poster | https://gcdtr.org/veterans-health-administration-corporate-data-warehouse-cdw/ ; https://www.ohdsi.org/web/wiki/lib/exe/fetch.php?media=resources%3Ava_omop_-_ohdsi_poster_sub_v2.pdf | UNVERIFIED |
| CDW databases | "approximately 7,500 databases hosted across 86 servers" | undated | https://atlaslongitudinaldatasets.ac.uk/datasets/va-cdw | UNVERIFIED |
| Lighthouse API traffic | No published calls/month or FHIR traffic figure found. Only: Benefits Intake "more than 68,000 claims" since launch; "22,700 forms" in one June; "243 developers" (2019) | 2019–2023 | https://digital.va.gov/general/lighthouse-apis-provide-solutions-to-improve-the-veteran-experience/ ; https://news.va.gov/58726/lighthouse-veteran-centered-api-program-va/ | UNVERIFIED — NO TRAFFIC FIGURE PUBLISHED |

## B. IHS

| figure | value | year | source URL | confidence |
|---|---|---|---|---|
| Service population | "2.8 million American Indians and Alaska Natives"; "Members of 574 federally recognized tribes in 37 states" | 2024 (Profile, 2022 data) | https://www.ihs.gov/sites/newsroom/themes/responsive2017/display_objects/documents/factsheets/IHSProfile.pdf | CITED (PDF text extracted) |
| Service population (alt.) | "approximately 2.2 million of the nation's estimated 3.7 million American Indians and Alaska Natives" | undated | https://www.ihs.gov/newsroom/factsheets/uihp/ | UNVERIFIED (snippet) |
| Areas / service units | "12 area offices and 170 IHS service units" | 2024 | IHSProfile.pdf (above) | CITED |
| Urban programs | "41 urban Indian organizations"; "41 UIOs with 80+ sites, as of 2022" | 2024 / 2022 | IHSProfile.pdf ; https://www.ihs.gov/urban/aboutus/about-urban-indian-organizations/ | CITED / UNVERIFIED |
| Facilities (IHS / Tribes), June 2023 | Hospital 21/22; Health Center 52/331; Health Station 25/76; Alaska Village Clinic 0/147; School Health Center 12/7; Youth Regional Treatment Centers 6/6 → 116 IHS + 589 tribal = 705 | 2024 | IHSProfile.pdf | CITED (sum is ASSUMPTION) |
| Hospitals | "Of the 43 hospitals, five IHS and nine tribal hospitals are critical access hospitals." | 2024 | IHSProfile.pdf | CITED |
| Inpatient admissions FY2023 | "36,959" | 2024 | IHSProfile.pdf | CITED |
| Outpatient visits FY2023 | "13,949,733" | 2024 | IHSProfile.pdf | CITED |
| Inpatient/outpatient FY2024 | "In FY 2024, IHS and Tribal facilities provided 37,201 inpatient admissions and 15,291,038 outpatient medical care visits (advance data, latest available)." | 2026 (FY2027 CJ draft) | https://www.ihs.gov/sites/ofa/themes/responsive2017/display_objects/documents/IHS%20Draft%20CJ%20FY%202027.pdf | CITED (PDF text extracted) |
| FY2027 workload request | "15,328,239 inpatient and outpatient visits" | 2026 | same FY2027 CJ | UNVERIFIED (snippet) |
| Employees | "Total IHS employees: 15,265" (Feb 2023) | 2024 | IHSProfile.pdf | CITED |
| Budget | FY2024 appropriation "$7.1 billion"; FY2026 request "$8.1 billion"; FY2027 "$9.1 billion in discretionary funding" | 2024–2026 | IHSProfile.pdf ; FY2027 CJ | CITED / UNVERIFIED |
| RPMS sites | RPMS EHR "is in use at approximately 430 health care facilities across the country" | 2026 (FY2027 CJ) | FY2027 CJ (above) | CITED (PDF text extracted) |
| RPMS sites (older) | "RPMS EHR was in use at 459 of 470 facilities (98%)" by July 2015 | 2015 | https://www.niddk.nih.gov/-/media/Files/Health-Information/Health-Professionals/Kidney-Disease/working-groups/Indian_Health_Service_A_Strategic_Plan_for_Population_Health_and_Analytics_508.pdf | UNVERIFIED (snippet) |
| RPMS scope | "over 50 integrated software applications"; "used daily in hundreds of locations" | current | https://www.ihs.gov/rpms/applications/ | UNVERIFIED (snippet) |
| PATH EHR contract | "On November 8, 2023, IHS announced that it selected General Dynamics Information Technology, Inc. (GDIT) ... utilizing Oracle Cerner technology"; LCCE "$4.5 billion to $6.2 billion throughout a 10-year period" | 2023 | https://www.ihs.gov/hit/path-ehr/ (503 on fetch; quote via search index) | UNVERIFIED |
| PATH EHR pilot | Lawton Service Unit, OK, pilot; "PATH EHR went live on September 26 [2026] at Lawton Indian Hospital, Anadarko Indian Health Center, and Carnegie Indian Health Center" | 2026 | https://www.hcinnovationgroup.com/clinical-it/electronic-health-record-electronic-medical-record-ehr-emr/news/55411922/indian-health-service-begins-ehr-modernization-roll-out-in-oklahoma ; FY2027 CJ names Lawton as pilot | UNVERIFIED (snippet) / CITED |
| PATH EHR rollout | "roll out to health sites over several years, with the first pilot expected in 2026"; ECG "15 clinical domains with approximately 200 subject matter experts" | 2025 | https://fedtechmagazine.com/article/2025/09/tribalnet-2025-ihs-advances-path-ehr-rollout-eyes-2026-pilot | UNVERIFIED (snippet) |
| IHS imaging volumes | No published IHS-wide imaging exam or image-storage figure found. | — | — | NOT FOUND |

## C. DICOM study sizes, imaging volumes, compression

Study sizes (uncompressed unless stated). Vendor capacity-planning sources; no single peer-reviewed table found that covers every modality.

| figure | value | year | source URL | confidence |
|---|---|---|---|---|
| Per-modality study size (conservative / typical / complex) | CT general 200 MB / 500 MB / 2 GB; CT cardiac 1 GB / 3 GB / 8 GB; MRI general 150 MB / 400 MB / 1.2 GB; MRI neuro 300 MB / 700 MB / 2 GB; CR 8 / 15 / 25 MB; DX 10 / 20 / 35 MB; US static 5 / 12 / 30 MB; US cine 200 MB / 600 MB / 2 GB; FFDM 50 / 120 / 250 MB; DBT 500 MB / 1.5 GB / 4 GB; NM 20 / 50 / 150 MB; PET-CT 800 MB / 2 GB / 5 GB; Fluoro 150 / 400 MB / 1.2 GB | 2026-02-14 | https://majware.com/blog/pacs-storage-growth-formula | CITED |
| Per-modality ranges (imaging-center view) | DR/CR 10–30 MB; US 30–200 MB; 2D mammo 40–100 MB; DBT 400 MB–3 GB; CT 100–500 MB; MR 50–250 MB; PET-CT 100–500 MB | 2026-08-13 | https://www.novaimaging.co/en/blog/how-much-storage-does-your-imaging-center-need/ | CITED |
| Modality mix, imaging centre | radiography 45 %, US 25 %, CT 15 %, MR 8 %, mammo 7 % of studies | 2026 | same Nova page | CITED |
| CT study size (2025 data) | thin-slice acquisition "median of 290 MB, versus 130 MB for a comparable thicker-slice exam"; full study with reformats "median reaches 787 MB" | 2025/2026 | https://www.rad365.com/blogs/medical-imaging-storage-growth-faster-than-study-volume-2026 | UNVERIFIED (snippet) |
| DBT vs 2D | "roughly 50 MB per study to over 1 GB on average ... more than twentyfold increase"; older: DBT "average about 450 MB ... as large as 3 GB" | 2026 / older | rad365 (above); https://www.purview.net/blog/pacs-requirements-for-digital-breast-tomosynthesis | UNVERIFIED |
| Per-image sizes / instances per study | CR 3520×4280 12-bit 30 MB, 2 images; CT 512×512 16-bit 0.524 MB/image, 40–3000 images; MG 4608×5200 14-bit 45.7 MB/image; MR 256×256 16-bit 0.131 MB/image, 60–3000 images | undated | https://www.dicomlibrary.com/dicom/study-structure/ | UNVERIFIED (snippet) |
| Digital pathology WSI | DICOM example: 20 mm × 15 mm at 0.25 µm/pixel, 24-bit ≈ "about 15GB" raw; "could be compressed with JPEG2000 to about 300MB"; multi-Z extreme "3.75TB" | DICOM WSI doc | https://dicom.nema.org/dicom/dicomwsi/ | UNVERIFIED (snippet) |
| WSI compressed size in practice | "100s of MB to several GB per slide"; "1 or 2 GB per slide" after compression | 2023 / NVIDIA | https://arxiv.org/pdf/2306.03619 ; https://developer.nvidia.com/blog/whole-slide-image-analysis-in-real-time-with-monai-and-rapids/ | UNVERIFIED (snippet) |
| Lossless ratios by modality (JPEG 2000) | CT 1.5–2.5:1; MRI 2–3:1; CR/DX 2–3:1; US 1.2–1.8:1; Mammo 1.5–2:1 | 2026 | https://majware.com/blog/pacs-storage-growth-formula | CITED |
| Lossless ratios, JPEG-LS vs JPEG 2000 (classic) | "JPEG-LS and JPEG 2000 best • Mean CR 6.27 and 6.25 For Presentation" (CT/MR set); lossless "typically 3:1 or 4:1 for CT and MR" | ~2003 (Clunie) | https://www.dclunie.com/papers/compressionJ2Kand3D.pdf | UNVERIFIED (snippet) |
| HTJ2K vs JPEG-LS lossless | "on dense diagnostic tissue, JPEG-LS and HTJ2K achieve similar lossless compression (~2.6–2.7×)"; HTJ2K files "approximately 5 to 7 percent larger than traditional JPEG 2000"; HTJ2K encode ~11× / decode ~5× faster than JPEG-LS | 2026 (vendor) | https://dcmsys.com/project/high-throughput-jpeg-2000-htj2k-a-practical-path-to-faster-scalable-medical-imaging/ | CITED |
| HTJ2K transfer syntaxes | 1.2.840.10008.1.2.4.201 (HTJ2K lossless), .202 (RPCL lossless), .203 (lossy allowed) | DICOM Sup 235 | https://www.dicomstandard.org/news-dir/progress/docs/sups/sup235.pdf | UNVERIFIED (snippet) |
| Intel HTJ2K study | goal "compression ratios of at least 2" lossless on 16-bit monochrome, encode/decode < 500 ms; recommends HTJ2K | Intel WP | https://cdrdv2-public.intel.com/835065/lossless-compression-wp-final.pdf | UNVERIFIED (snippet) |
| PACS growth, 500-bed hospital | 138,500 studies/yr (CT 28,000; MRI 12,000; CR 45,000; DX 18,000; US 22,000; NM 2,500; MG 8,000; FL 3,000) → "22.4 TB/yr" raw, "about 11.8 TB/year" compressed | 2026 | https://majware.com/blog/pacs-storage-growth-formula | CITED |
| PACS growth per 100k studies | 22.4 TB / 138,500 studies ≈ 16.2 TB raw (≈ 8.5 TB lossless-compressed) per 100,000 studies at that mix | — | derived from the row above | ASSUMPTION |
| PACS growth, other vendor figures | "500-bed facility ... 30–50 TB of new imaging data per year"; "300-bed ... 15–20 terabytes"; volume "roughly doubles every 5 to 7 years" | 2026 | https://www.omnipacs.com/pacs-data-management-at-scale-multi-site/ | UNVERIFIED (snippet) |
| VA imaging storage at that rate | 10–12 M exams/yr (section A) × ~160 MB avg raw (Majware mix) ≈ 1.6–1.9 PB/yr raw, ~0.9–1.0 PB/yr lossless | — | derived | ASSUMPTION |
| US CT procedures | "In 2018, 88.7 million CT procedures ... 2019 ... 91.4 million ... 2020 ... 73 million ... 2021 ... 84.5 million ... 2022 ... 85.3 million" | 2022 (IMV) | https://imvinfo.com/product-category/imaging/ct/ ; https://www.auntminnie.com/clinical-news/ct/article/15633200/imv-cta-and-ldct-procedures-show-fiveyear-growth-trend | UNVERIFIED (snippet) |
| US MRI procedures | "33.8 million MR procedures were performed in the United States in 2013" (IMV) | 2013 | https://www.auntminnie.com/clinical-news/mri/article/15587149/mri-procedure-growth-rate-slows-study-shows | UNVERIFIED (snippet) |
| US CT+MRI+PET per 1,000 | US among countries with "a combined total of over 360 exams per 1 000 population in 2021" | 2023 (OECD HaaG 2023) | https://www.oecd.org/en/publications/2023/11/health-at-a-glance-2023_e04f8239/full-report/diagnostic-technologies_23088ad0.html | UNVERIFIED (snippet) |
| US MRI per 1,000 | "110.8" (2017 data, OECD 2019) | 2019 | https://www.commonwealthfund.org/international-health-policy-center/system-stats/mri-exams-per-1000 (403 on fetch) | UNVERIFIED |
| US CT per 1,000 | ~255 (2021, Statista/OECD) | 2021 | https://www.statista.com/statistics/283085/computer-tomography-examinations-in-selected-countries/ | UNVERIFIED |
| Imaging rate trend, US adults | "imaging tests per 1,000 people rose from 256 to 270" (2009→2019, CT+MRI in 7 US systems) | JAMA Netw Open | cited via search; no URL captured | UNVERIFIED |
| OECD CT average | "The OECD average is 161.7 per 1,000 population" (2022–23) | 2024 (CADTH CMII) | https://www.ncbi.nlm.nih.gov/books/NBK607341/figure/fig20/?report=objectonly | UNVERIFIED (bot wall on fetch) |

## D. FHIR resource counts per patient and server throughput

| figure | value | year | source URL | confidence |
|---|---|---|---|---|
| Synthea resources per patient | "Corpus Synthea (seed 3256262546): 100,000 patients, 112,322,471 resources" → 1,123 resources/patient; Observation 63,950,790 (56.9 %), DiagnosticReport 17,237,029 (15.3 %), Procedure 15,615,811 (13.9 %), Condition 5,658,095 (5.0 %) | 2026-07 (arXiv 2607.23619) | https://arxiv.org/pdf/2607.23619 | CITED (PDF text extracted) |
| Synthea size on disk | "Raw corpus 100,000 gzipped transaction bundles, 17.8 GB"; "NDJSON ... 20 gzipped shards, 10.4 GB" → ≈178 KB gz bundle/patient, ≈104 KB gz NDJSON/patient | 2026 | same paper | CITED (per-patient division is ASSUMPTION) |
| Synthea uncompressed JSON per patient | 10× gzip ratio for JSON ⇒ ~1–2 MB/patient uncompressed; vendor note: "each patient generates FHIR JSON files that can be 0.5-1 MB" | — | https://apify.com/johnvc/synthea-medical-record-generator-api | ASSUMPTION / UNVERIFIED |
| Synthea sample downloads | "100 Sample Synthetic Patient Records, FHIR R4: 36 MB" (zip); "1K ... FHIR R4: 81 MB" | current | https://synthea.mitre.org/downloads | UNVERIFIED (snippet) |
| Health Samurai benchmark dataset | "1,000 synthetic patient records generated with Synthea (around 2 million resources in total)"; bundles "150 KB to ... 120 MB and up to 50,000 resources" | 2026-04/07 | https://www.health-samurai.io/articles/performance-at-scale-baseline (methodology page fetched: 2026-04-08; results page not fetchable) | UNVERIFIED (results via snippet) |
| Microsoft FHIR Server (OSS, SQL) throughput | "440 RPS" CRUD; "379 ms p99" reads; "~1.2 s p99 on create and update"; bundle import "448 resources per second"; Medplum "764 resources per second" | 2026 (vendor benchmark by Aidbox maker) | https://www.health-samurai.io/articles/performance-at-scale-baseline | UNVERIFIED (snippet) |
| HAPI FHIR throughput | "HAPI FHIR managed 252 RPS but with p95 of 420ms"; stalls "at 265 RPS" at 1000 users | Medblocks | https://medblocks.com/blog/couchbase-fhir-vs-hapi-fhir-who-is-faster | UNVERIFIED (snippet) |
| Smile CDR bulk load | "1 million Synthea patients (1 billion+ resources, 2.182 TiB raw FHIR data) completed in 24 hours and 9 minutes ... 11.6 complete patient records/second — around 11,700 resources/sec" | ~2023 | https://vneilley.medium.com/most-fhir-servers-are-unusable-in-production-8833cb1480b1 | UNVERIFIED (snippet) |
| Azure API for FHIR loader | "FHIR Loader — 500 resources a second at default 10,000 RU/s" | ~2023 | same Medium post | UNVERIFIED (snippet) |
| AHDS $import guidance | "optimal NDJSON file size for import is 50 MB or larger (or 20,000 resources or more)"; "Aim for a total file size of 100 GB or more (or 100 million resources ...) in one operation"; "throughput doesn't increase with concurrent import jobs" | current | https://learn.microsoft.com/en-us/azure/healthcare-apis/fhir/fhir-best-practices | UNVERIFIED (snippet) — NO OFFICIAL resources/s FIGURE |
| AHDS $export | "a database with 50 million resources might take 8-12 hours" | 2026 (migration guide) | https://saga-it.com/blog/azure-fhir-migration-guide | UNVERIFIED |
| Google Cloud Healthcare API | Synthea benchmark "50 million patient records (26 billion FHIR resources)"; import limits: resource 10 MB, Binary 1 GB; no resources/s published | 2021 | https://www.devdays.com/wp-content/uploads/2021/12/Healthcare-API-ONIX-merged.pdf (DNS fail on fetch) ; https://docs.cloud.google.com/healthcare-api/quotas | UNVERIFIED |
| HAPI bulk export mechanics | "Retry-After: 120"; "HAPI writes 1,000 resources per file" | 2026 | https://github.com/ohs-foundation/fhir-pipes-rs/issues/61 | UNVERIFIED (snippet) |
| Sizing: VA FHIR footprint | 7.7 M patients × 1,123 resources ≈ 8.6 B resources; × ~1.5 MB/patient JSON ≈ 11–12 TB uncompressed, ~1.4 TB gz NDJSON (Synthea shape; real EHR data is denser in notes/documents) | — | derived | ASSUMPTION |

## E. Azure unit prices (USD, pay-as-you-go list, Retail Prices API, 2026-10-22)

Gov = `usgovvirginia`; Com = `eastus`. Year = meter `effectiveStartDate`.

| figure | value | year | source URL | confidence |
|---|---|---|---|---|
| PostgreSQL Flex GP D16ds_v5 (16 vCore) | Gov 1.712 /hr; Com 1.424 /hr | 2023 | https://prices.azure.com/api/retail/prices (serviceName 'Azure Database for PostgreSQL', product '...General Purpose Ddsv5 Series Compute', sku '16 vCore') | CITED |
| PostgreSQL Flex MO E16ds_v5 (16 vCore) | Gov 2.44 /hr; Com 2.00 /hr | 2023 | same API, product '...Memory Optimized Edsv5 Series Compute' | CITED |
| PostgreSQL Flex storage, Premium SSD (standard) | Com 0.115 /GB-month ("Storage Data Stored"); Gov: no "Storage Data Stored" meter returned for usgovvirginia — UNVERIFIED, use pricing page https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/ | 2021 | same API | CITED (Com) / UNVERIFIED (Gov) |
| PostgreSQL Flex storage, Premium SSD v2 | Gov 0.138 /GiB-month, IOPS 0.025 /IOPS-month, throughput 0.10 /MBps-month; Com 0.115 /GiB-month, 0.02 /IOPS-month, 0.08 /MBps-month | 2023 | same API, product 'Azure Database for PostgreSQL Flex Server Storage' | CITED |
| PostgreSQL Flex backup storage | Com 0.095 /GB-month (LRS) | 2021 | same API | CITED |
| PostgreSQL Flex provisioned IOPS (Premium SSD) | Gov 0.06 /IOPS-month; Com 0.05 /IOPS-month | 2023 | same API, 'IOPS Scaling' | CITED |
| Blob Hot LRS | Gov 0.0296 (first tier) / 0.028416 / 0.027232 per GB-month; Com (third-party) 0.0184 | 2017 / 2026 | API ; https://www.nops.io/blog/azure-storage-pricing/ | CITED (Gov) / UNVERIFIED (Com) |
| Blob Hot ZRS | Gov 0.037 / 0.03552 / 0.03404 | 2021 | API | CITED |
| Blob Hot GZRS | Gov 0.053673 / 0.051633 / 0.049184 | 2024 | API | CITED |
| Blob Cool LRS / ZRS / GZRS | Gov 0.016 / 0.02 / 0.035 per GB-month; retrieval 0.01 /GB | 2016–2024 | API | CITED |
| Blob Cold LRS / ZRS | Gov 0.00576 / 0.0064 per GB-month; retrieval 0.03 /GB; write 0.18 / 0.20 per 10K; read 0.10 per 10K | 2023 | API | CITED |
| Blob Archive LRS / GRS | Gov 0.0024 / 0.0054 per GB-month; retrieval (standard) 0.026 /GB; priority retrieval 0.125 /GB; read ops 6.5 per 10K (priority 62.5 per 10K); write 0.15 / 0.30 per 10K | 2018–2020 | API | CITED |
| Blob Hot transactions | Gov write 0.05 (LRS) / 0.0625 (ZRS) per 10K; read 0.004 per 10K; other 0.004 per 10K | 2016–2021 | API | CITED |
| VM D16s_v5 Linux | Gov 0.968 /hr; Com 0.768 /hr | 2024 / 2021 | API (serviceName 'Virtual Machines', armSkuName Standard_D16s_v5) | CITED |
| VM E16s_v5 Linux | Com 1.008 /hr; Gov: Standard_E16s_v5 not offered in usgovvirginia — nearest E16ds_v5 1.384 /hr, E16as_v5 1.088 /hr | 2021 / 2023 | API | CITED |
| AKS control plane | Standard tier uptime SLA fee not queried; AKS node cost = VM rows above | — | https://learn.microsoft.com/en-us/azure/aks/free-standard-pricing-tiers | UNVERIFIED |
| Event Hubs Premium PU | Gov 1.284 /PU-hr; Com 1.027 /PU-hr | 2021 | API (serviceName 'Event Hubs') | CITED |
| Event Hubs Dedicated CU | Gov 8.561 /CU-hr; Com 6.849 /CU-hr; extended retention 0.125 /GB-month (Gov) | 2019–2021 | API | CITED |
| Key Vault Managed HSM (Standard B1 pool) | Gov 4.00 /hr; Com 3.20 /hr | 2021 | API (product 'Key Vault HSM Pool') | CITED |
| Key Vault Premium HSM-protected keys | Gov: RSA-2048 1.25 /key-month; advanced keys 0.5–6.25 /key-month; ops 0.0375 /10K (advanced 0.188 /10K) | 2020 | API | CITED |
| Front Door Premium | Base fee: US Gov Zone 1 412.50 /month; Zone 1 (Com) 330.00 /month. Requests US Gov Zone 1 0.01875 → 0.015701 per 10K (tiered); Zone 1 0.015 → 0.012561. Egress US Gov Zone 1 0.103125 → 0.006755 /GB; Zone 1 0.0825 → 0.005404 /GB | 2022–2023 | API (serviceName 'Azure Front Door Service', sku Premium) | CITED |
| API Management Premium v2 | Gov 4.79452 /unit-hr (secondary unit 2.39726); Com 3.83562 /unit-hr (secondary 1.91781) | 2024 | API (sku 'Premium v2') | CITED |
| API Management Premium (classic) | Gov 4.78625 /unit-hr | 2018 | API | CITED |
| Log Analytics (Analytics Logs) | Gov ingestion 2.88 /GB, retention 0.13 /GB-month; Com ingestion 2.30 /GB, retention 0.10 /GB-month | 2018 | API (serviceName 'Log Analytics') | CITED |
| Azure Cache for Redis Premium P1 (6 GB) | Gov 0.555 /hr (cache, 2 nodes) / 0.277 /hr per instance; Com 0.555 / 0.277 /hr. Service retires 2028-04-30 (Azure Managed Redis successor) | 2016–2019 | API (serviceName 'Redis Cache') ; retirement: https://redis.io/blog/how-moving-from-azure-cache-for-redis-to-azure-managed-redis-can-cut-costs-by-40percent/ | CITED / UNVERIFIED (retirement) |

## F. Azure limits

| figure | value | year | source URL | confidence |
|---|---|---|---|---|
| Storage account capacity | "Default maximum storage account capacity 5 PiB" (higher by request) | 2025-10 (page) | https://learn.microsoft.com/en-us/azure/storage/common/scalability-targets-standard-account | CITED |
| Storage account request rate | "40,000 requests per second" in listed regions incl. "USGov Arizona, USGov Virginia"; "20,000 requests per second" elsewhere | 2025 | same | CITED |
| Storage account ingress / egress | 60 Gbps ingress / 200 Gbps egress (listed regions incl. USGov Virginia); 25 / 50 Gbps elsewhere | 2025 | same | CITED |
| Accounts per region per subscription | "250 by default, 1000 by request" | 2025 | same | CITED |
| Blobs/containers per account | "No limit" | 2025 | same | CITED |
| Max block blob | "50,000 x 4,000 MiB (approximately 190.7 TiB)"; single Put Blob 5,000 MiB; block 4,000 MiB | 2026-07 (page) | https://learn.microsoft.com/en-us/azure/storage/blobs/scalability-targets | CITED |
| Single blob request rate | "Up to 3,000 requests per second" (block blob); page blob 500 rps, 60 MiB/s; append blob ≈195 GiB; page blob 8 TiB | 2026 | same | CITED |
| ADLS Gen2 | Not a separate account type; same account targets apply. Guidance: files "256 MB to 100 GB"; ops billed in 4 MB increments | 2026-06 | https://learn.microsoft.com/en-us/azure/storage/blobs/data-lake-storage-best-practices | CITED |
| PostgreSQL Flex max storage | "32 TiB with Premium SSD ... 20,000 IOPS and 900 MB/s"; "Premium SSD v2 ... up to 64 TiB with support for 80,000 IOPS and 1,200 MB/s" | 2026 | https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-storage ; https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-storage-premium-ssd-v2 | UNVERIFIED (snippet) |
| PostgreSQL Flex max connections | D16ds_v5 (64 GiB) "5,000 / 4,985"; E16ds_v5 (128 GiB) "5,000 / 4,985"; "reserves 15 connections"; D2 859, D4 1,718, D8 3,437 | 2026-07 (page) | https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-limits | CITED |
| PostgreSQL Flex read-only trip | "storage usage reaches 95% or ... available capacity is less than 5 GiB" → read-only | 2026 | same | CITED |
| Event Hubs TU | "Ingress: 1 MB/sec or 1,000 events per second; Egress: 2 MB/sec or 4,096 events per second"; max "40 TUs"; 84 GB retention per TU; 1 MB event (Standard) | 2026-02 (page) | https://learn.microsoft.com/en-us/azure/event-hubs/event-hubs-quotas | CITED |
| Event Hubs Premium PU | "16 PUs" max; "No limits per PU *"; 1 TB retention per PU; 100 event hubs per PU; 200 partitions per PU; 10,000 brokered connections per PU; 90-day retention | 2026 | same | CITED |
| Event Hubs Dedicated CU | "10 CUs (more via support request)"; 20 MB publication; 10 TB per CU; 1,000 event hubs/namespace; 1,024 partitions per event hub, 2,000 per CU; 100,000 connections per CU | 2026 | same | CITED |
| AKS nodes | "Maximum nodes per cluster with Virtual Machine Scale Sets and Standard Load Balancer SKU 5,000 across all node pools"; "Maximum nodes per node pool 1000"; "Maximum node pools per cluster 100"; clusters per subscription 5,000 | 2026-08 (page) | https://learn.microsoft.com/en-us/azure/aks/quotas-skus-regions | CITED |
| AKS pods per node | "Maximum: 250" (kubenet and Azure CNI); CLI default 110; portal default 30 | 2026 | same | CITED |
| AKS pods per cluster | "up to 5,000 nodes per AKS cluster and 200,000 pods per AKS cluster (with Azure CNI Overlay)" | 2026 | https://learn.microsoft.com/en-us/azure/aks/best-practices-performance-scale-large | UNVERIFIED (snippet) |
| AKS LB services | "Maximum load-balanced kubernetes services per cluster with Standard Load Balancer SKU 300" | 2026 | quotas-skus-regions (above) | CITED |

## Gaps (searched, not found)

- VA Lighthouse / Health API call volumes: no published figure.
- VistA Imaging total PB after 2009: no published figure (extrapolation only).
- VA CDW current size (2020s): no published figure; only "over 50 TB" (undated) and VINCI 1.5 PB (2018).
- IHS imaging volumes: none published.
- Official Microsoft resources/s for AHDS `$import`/`$export`: none published.
- US Gov Virginia price for PostgreSQL Flex standard (Premium SSD) storage and Standard_E16s_v5: meters absent from the API for that region.
