import type { Person } from '@companyenrich/sdk';

// Value lists from the CompanyEnrich v2 API, in their natural order. Pure data,
// safe to import from browser code.

export const EMPLOYEE_RANGES = ['1-10', '11-50', '51-200', '201-500', '501-1K', '1K-5K', '5K-10K', 'over-10K'] as const;
export type EmployeeRange = (typeof EMPLOYEE_RANGES)[number];

export const REVENUE_RANGES = ['under-1m', '1m-10m', '10m-50m', '50m-100m', '100m-200m', '200m-1b', 'over-1b'] as const;
export type RevenueRange = (typeof REVENUE_RANGES)[number];

export const CATEGORIES = ['b2b', 'b2c', 'b2g', 'e-commerce', 'media', 'service-provider', 'mobile', 'saas', 'local-business'] as const;
export type Category = (typeof CATEGORIES)[number];

export const SENIORITIES = ['owner', 'founder', 'c-suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern'] as const;
export type Seniority = (typeof SENIORITIES)[number];

/** Every v2 people department. A root such as `sales` also matches its sub-departments. */
export const DEPARTMENTS = [
  'c-suite', 'c-suite/executive', 'c-suite/finance-executive', 'c-suite/founder', 'c-suite/human-resources-executive',
  'c-suite/information-technology-executive', 'c-suite/legal-executive', 'c-suite/marketing-executive',
  'c-suite/medical-health-executive', 'c-suite/operations-executive', 'c-suite/sales-executive', 'product-management',
  'product-management/product-development', 'product-management/product-management', 'engineering-technical',
  'engineering-technical/artificial-intelligence-machine-learning', 'engineering-technical/bioengineering',
  'engineering-technical/biometrics', 'engineering-technical/business-intelligence',
  'engineering-technical/chemical-engineering', 'engineering-technical/cloud-mobility',
  'engineering-technical/data-science', 'engineering-technical/devops', 'engineering-technical/digital-transformation',
  'engineering-technical/emerging-technology-innovation', 'engineering-technical/engineering-technical',
  'engineering-technical/industrial-engineering', 'engineering-technical/mechanic',
  'engineering-technical/mobile-development', 'engineering-technical/project-management',
  'engineering-technical/research-development', 'engineering-technical/scrum-master-agile-coach',
  'engineering-technical/software-development', 'engineering-technical/support-technical-services',
  'engineering-technical/technician', 'engineering-technical/technology-operations',
  'engineering-technical/test-quality-assurance', 'engineering-technical/ui-ux',
  'engineering-technical/web-development', 'design', 'design/all-design', 'design/product-ui-ux-design',
  'design/graphic-design', 'education', 'education/teacher', 'education/principal', 'education/superintendent',
  'education/professor', 'finance', 'finance/accounting', 'finance/finance', 'finance/financial-planning-analysis',
  'finance/financial-reporting', 'finance/financial-strategy', 'finance/financial-systems',
  'finance/internal-audit-control', 'finance/investor-relations', 'finance/mergers-acquisitions',
  'finance/real-estate-finance', 'finance/financial-risk', 'finance/shared-services', 'finance/sourcing-procurement',
  'finance/tax', 'finance/treasury', 'human-resources', 'human-resources/compensation-benefits',
  'human-resources/culture-diversity-inclusion', 'human-resources/employee-labor-relations',
  'human-resources/health-safety', 'human-resources/human-resource-information-system',
  'human-resources/human-resources', 'human-resources/hr-business-partner', 'human-resources/learning-development',
  'human-resources/organizational-development', 'human-resources/recruiting-talent-acquisition',
  'human-resources/talent-management', 'human-resources/workforce-management', 'human-resources/people-operations',
  'information-technology', 'information-technology/application-development',
  'information-technology/business-service-management-itsm', 'information-technology/collaboration-web-app',
  'information-technology/data-center', 'information-technology/data-warehouse',
  'information-technology/database-administration', 'information-technology/ecommerce-development',
  'information-technology/enterprise-architecture', 'information-technology/help-desk-desktop-services',
  'information-technology/hr-financial-erp-systems', 'information-technology/information-security',
  'information-technology/information-technology', 'information-technology/infrastructure',
  'information-technology/it-asset-management', 'information-technology/it-audit-it-compliance',
  'information-technology/it-operations', 'information-technology/it-procurement',
  'information-technology/it-strategy', 'information-technology/it-training', 'information-technology/networking',
  'information-technology/project-program-management', 'information-technology/quality-assurance',
  'information-technology/retail-store-systems', 'information-technology/servers',
  'information-technology/storage-disaster-recovery', 'information-technology/telecommunications',
  'information-technology/virtualization', 'legal', 'legal/acquisitions', 'legal/compliance', 'legal/contracts',
  'legal/corporate-secretary', 'legal/ediscovery', 'legal/ethics', 'legal/governance',
  'legal/governmental-affairs-regulatory-law', 'legal/intellectual-property-patent', 'legal/labor-employment',
  'legal/lawyer-attorney', 'legal/legal', 'legal/legal-counsel', 'legal/legal-operations', 'legal/litigation',
  'legal/privacy', 'marketing', 'marketing/advertising', 'marketing/brand-management', 'marketing/content-marketing',
  'marketing/customer-experience', 'marketing/customer-marketing', 'marketing/demand-generation',
  'marketing/digital-marketing', 'marketing/ecommerce-marketing', 'marketing/event-marketing',
  'marketing/field-marketing', 'marketing/lead-generation', 'marketing/marketing',
  'marketing/marketing-analytics-insights', 'marketing/marketing-communications', 'marketing/marketing-operations',
  'marketing/product-marketing', 'marketing/public-relations', 'marketing/search-engine-optimization-pay-per-click',
  'marketing/social-media-marketing', 'marketing/strategic-communications', 'marketing/technical-marketing',
  'medical-health', 'medical-health/anesthesiology', 'medical-health/chiropractics', 'medical-health/clinical-systems',
  'medical-health/dentistry', 'medical-health/dermatology', 'medical-health/doctors-physicians',
  'medical-health/epidemiology', 'medical-health/first-responder', 'medical-health/infectious-disease',
  'medical-health/medical-administration', 'medical-health/medical-education-training',
  'medical-health/medical-research', 'medical-health/medicine', 'medical-health/neurology', 'medical-health/nursing',
  'medical-health/nutrition-dietetics', 'medical-health/obstetrics-gynecology', 'medical-health/oncology',
  'medical-health/opthalmology', 'medical-health/optometry', 'medical-health/orthopedics', 'medical-health/pathology',
  'medical-health/pediatrics', 'medical-health/pharmacy', 'medical-health/physical-therapy',
  'medical-health/psychiatry', 'medical-health/psychology', 'medical-health/public-health', 'medical-health/radiology',
  'medical-health/social-work', 'operations', 'operations/call-center', 'operations/construction',
  'operations/corporate-strategy', 'operations/customer-service-support', 'operations/enterprise-resource-planning',
  'operations/facilities-management', 'operations/leasing', 'operations/logistics', 'operations/office-operations',
  'operations/operations', 'operations/physical-security', 'operations/project-development',
  'operations/quality-management', 'operations/real-estate', 'operations/safety', 'operations/store-operations',
  'operations/supply-chain', 'sales', 'sales/account-management', 'sales/business-development', 'sales/channel-sales',
  'sales/customer-retention-development', 'sales/customer-success', 'sales/field-outside-sales', 'sales/inside-sales',
  'sales/partnerships', 'sales/revenue-operations', 'sales/sales', 'sales/sales-enablement', 'sales/sales-engineering',
  'sales/sales-operations', 'sales/sales-training', 'consulting', 'consulting/consultant',
] as const satisfies readonly NonNullable<Person['department']>[];
export type Department = (typeof DEPARTMENTS)[number];

export const TIERS = ['A', 'B', 'C', 'unqualified'] as const;
export type Tier = (typeof TIERS)[number];
