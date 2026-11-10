-- Tiny hand-made registry for tests and for running before the real ETL finishes.
-- Organizations are real names; counts are small round numbers, NOT the real figures.
CREATE TABLE cms_hospitals(ccn TEXT PRIMARY KEY, name TEXT, address TEXT, city TEXT, state TEXT, zip TEXT, county TEXT, phone TEXT, hospital_type TEXT, ownership TEXT, emergency TEXT, overall_rating TEXT, name_norm TEXT);
CREATE TABLE ahrq_systems(health_sys_id TEXT PRIMARY KEY, name TEXT, city TEXT, state TEXT, hosp_cnt INT, acutehosp_cnt INT, sys_beds INT, total_mds INT, multistate INT, name_norm TEXT, source_year INT);
CREATE TABLE ahrq_hospital_links(ccn TEXT, health_sys_id TEXT, hospital_name TEXT, state TEXT, beds INT, source_year INT, PRIMARY KEY(ccn, health_sys_id));
CREATE TABLE payers(slug TEXT PRIMARY KEY, name TEXT, parent TEXT, domain TEXT, kind TEXT, source TEXT, name_norm TEXT);
CREATE TABLE curated_orgs(domain TEXT PRIMARY KEY, name TEXT, segment TEXT, subsegment TEXT, size_class TEXT, source_url TEXT, dns_ok INT);
CREATE TABLE org_domains(domain TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, name TEXT, evidence TEXT, verified_at TEXT);
CREATE TABLE free_mail_domains(domain TEXT PRIMARY KEY);
CREATE TABLE disposable_domains(domain TEXT PRIMARY KEY);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);

INSERT INTO meta VALUES ('status','mini'), ('built','hand-made test registry');

INSERT INTO free_mail_domains VALUES ('gmail.com'),('outlook.com'),('yahoo.com'),('hotmail.com'),('icloud.com');
INSERT INTO disposable_domains VALUES ('mailinator.com'),('guerrillamail.com'),('10minutemail.com');

INSERT INTO ahrq_systems VALUES
 ('SYS-INTERMTN','Intermountain Health','Salt Lake City','UT',33,31,5000,3000,1,'intermountain health',2023),
 ('SYS-OHIOHLTH','OhioHealth','Columbus','OH',15,13,3500,2500,0,'ohiohealth',2023),
 ('SYS-NORTHSIDE','Northside Hospital','Atlanta','GA',6,6,2000,1500,0,'northside hospital',2023),
 ('SYS-TANNER','Tanner Health System','Carrollton','GA',4,4,700,500,0,'tanner health system',2023),
 ('SYS-JHHS','Johns Hopkins Health System','Baltimore','MD',6,6,2500,3000,1,'johns hopkins health system',2023),
 ('SYS-GEISINGER','Geisinger','Danville','PA',10,9,2600,1700,0,'geisinger',2023),
 ('SYS-BHSF','Baptist Health South Florida','Coral Gables','FL',12,10,3000,2800,0,'baptist health south florida',2023),
 ('SYS-BHKY','Baptist Health','Louisville','KY',9,9,2900,2100,0,'baptist health',2023),
 ('SYS-BHAR','Baptist Health','Little Rock','AR',7,7,1500,1100,0,'baptist health',2023),
 ('SYS-BHSA','Baptist Health System','San Antonio','TX',5,5,1900,1200,0,'baptist health system',2023),
 ('SYS-BHCARE','Baptist Health Care','Pensacola','FL',3,3,1000,800,0,'baptist health care',2023),
 ('SYS-SMALL','Valley Community Health','Spokane','WA',2,2,300,100,0,'valley community health',2023),
 -- added for the working-day fixtures (fixtures/day/morning.json): the enterprise and referral tests
 ('SYS-COMMONSPIRIT','CommonSpirit Health','Chicago','IL',140,130,20000,9000,1,'commonspirit health',2023),
 ('SYS-PIEDMONT','Piedmont Healthcare','Atlanta','GA',20,18,3500,2000,0,'piedmont healthcare',2023),
 ('SYS-EMORY','Emory Healthcare','Atlanta','GA',10,9,2500,2500,0,'emory healthcare',2023);

INSERT INTO cms_hospitals VALUES
 ('460010','Intermountain Medical Center','5121 S Cottonwood St','Murray','UT','84107','Salt Lake','8015071000','Acute Care Hospitals','Voluntary non-profit - Private','Yes','4','intermountain medical center'),
 ('360006','Riverside Methodist Hospital','3535 Olentangy River Rd','Columbus','OH','43214','Franklin','6147222000','Acute Care Hospitals','Voluntary non-profit - Private','Yes','4','riverside methodist hospital'),
 ('110074','Northside Hospital Atlanta','1000 Johnson Ferry Rd','Atlanta','GA','30342','Fulton','4048512000','Acute Care Hospitals','Voluntary non-profit - Private','Yes','4','northside hospital atlanta'),
 ('110189','Northside Hospital Cherokee','450 Northside Cherokee Blvd','Canton','GA','30115','Cherokee','7705481000','Acute Care Hospitals','Voluntary non-profit - Private','Yes','3','northside hospital cherokee'),
 ('500005','Jefferson Healthcare','834 Sheridan St','Port Townsend','WA','98368','Jefferson','3603855100','Critical Access Hospitals','Government - Hospital District or Authority','Yes','4','jefferson healthcare'),
 ('210009','Johns Hopkins Hospital','1800 Orleans St','Baltimore','MD','21287','Baltimore City','4105505000','Acute Care Hospitals','Voluntary non-profit - Private','Yes','5','johns hopkins hospital'),
 ('100001','Baptist Hospital of Miami','8900 N Kendall Dr','Miami','FL','33176','Miami-Dade','7862445000','Acute Care Hospitals','Voluntary non-profit - Private','Yes','4','baptist hospital of miami'),
 ('180001','Baptist Health Louisville','4000 Kresge Way','Louisville','KY','40207','Jefferson','5028967000','Acute Care Hospitals','Voluntary non-profit - Private','Yes','4','baptist health louisville');

INSERT INTO ahrq_hospital_links VALUES
 ('460010','SYS-INTERMTN','Intermountain Medical Center','UT',500,2023),
 ('360006','SYS-OHIOHLTH','Riverside Methodist Hospital','OH',1000,2023),
 ('110074','SYS-NORTHSIDE','Northside Hospital Atlanta','GA',600,2023),
 ('110189','SYS-NORTHSIDE','Northside Hospital Cherokee','GA',200,2023),
 ('210009','SYS-JHHS','Johns Hopkins Hospital','MD',1000,2023),
 ('100001','SYS-BHSF','Baptist Hospital of Miami','FL',700,2023),
 ('180001','SYS-BHKY','Baptist Health Louisville','KY',500,2023);

INSERT INTO payers VALUES
 ('bcbs-michigan','Blue Cross Blue Shield of Michigan','Blue Cross Blue Shield Association','bcbsm.com','blue','curated','blue cross blue shield of michigan'),
 ('priority-health','Priority Health','Corewell Health','priorityhealth.com','regional','curated','priority health'),
 ('highmark','Highmark Health','','highmarkhealth.org','blue','curated','highmark health'),
 ('independence-blue-cross','Independence Blue Cross','','ibx.com','blue','curated','independence blue cross'),
 ('smallplan','Cascade Mutual Health Plan','','cascademutual.example','other','curated','cascade mutual health plan'),
 ('humana','Humana','','humana.com','national','curated','humana');

INSERT INTO curated_orgs VALUES
 ('mercer.com','Mercer','benefits_consultant_broker','benefits consulting','national','https://example.org/curated',1),
 ('turquoise.health','Turquoise Health','competitor','price transparency data','national','https://example.org/curated',1),
 ('meritain.com','Meritain Health','tpa','third-party administrator','national','https://example.org/curated',1),
 ('gene.com','Genentech','life_sciences','pharma','national','https://example.org/curated',1),
 ('chartis.com','Chartis','consulting_advisory','healthcare advisory','national','https://example.org/curated',1),
 ('paytient.com','Paytient','innovator_api_data','patient payments','other','https://example.org/curated',1),
 ('transcarent.com','Transcarent','innovator_navigation','care navigation','national','https://example.org/curated',1),
 ('hylant.com','Hylant','benefits_consultant_broker','benefits broker','regional','https://example.org/curated',1);

INSERT INTO org_domains VALUES
 ('intermountainhealthcare.org','ahrq_system','SYS-INTERMTN','Intermountain Health','mini registry','2026-11-06'),
 ('ohiohealth.com','ahrq_system','SYS-OHIOHLTH','OhioHealth','mini registry','2026-11-06'),
 ('geisinger.org','ahrq_system','SYS-GEISINGER','Geisinger','mini registry','2026-11-06'),
 ('jhmi.edu','ahrq_system','SYS-JHHS','Johns Hopkins Health System','mini registry','2026-11-06'),
 ('baptisthealth.net','ahrq_system','SYS-BHSF','Baptist Health South Florida','mini registry','2026-11-06'),
 ('jeffersonhealthcare.org','cms_hospital','500005','Jefferson Healthcare','mini registry','2026-11-06'),
 ('bcbsm.com','payer','bcbs-michigan','Blue Cross Blue Shield of Michigan','mini registry','2026-11-06'),
 ('priorityhealth.com','payer','priority-health','Priority Health','mini registry','2026-11-06'),
 ('commonspirit.org','ahrq_system','SYS-COMMONSPIRIT','CommonSpirit Health','mini registry','2026-11-10'),
 ('piedmont.org','ahrq_system','SYS-PIEDMONT','Piedmont Healthcare','mini registry','2026-11-10'),
 ('emoryhealthcare.org','ahrq_system','SYS-EMORY','Emory Healthcare','mini registry','2026-11-10'),
 ('humana.com','payer','humana','Humana','mini registry','2026-11-10');
