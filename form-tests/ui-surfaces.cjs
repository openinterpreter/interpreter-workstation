const SOURCE_SURFACES = {
  email: [
    {
      family: 'email-client',
      productName: 'Relay Mail',
      workspaceLabel: 'Customer Operations',
      accent: 'blue',
      sidebarTitle: 'Folders',
      sidebarItems: ['Inbox', 'Priority', 'Customer Ops', 'Archive'],
      filters: ['Unread', 'Assigned', 'Flagged'],
      headerActions: ['Reply', 'Forward', 'Archive'],
      secondaryMeta: ['Inbox', 'Operations'],
    },
    {
      family: 'email-client',
      productName: 'Northwind Mail',
      workspaceLabel: 'RevOps Inbox',
      accent: 'indigo',
      sidebarTitle: 'Mailboxes',
      sidebarItems: ['Assigned', 'Accounts', 'Leads', 'Archive'],
      filters: ['Unread', 'Important', 'Needs Reply'],
      headerActions: ['Reply', 'Snooze', 'Archive'],
      secondaryMeta: ['Leads', 'Follow-up'],
    },
  ],
  chat: [
    {
      family: 'team-chat',
      productName: 'Orbit Chat',
      workspaceLabel: 'Customer Success',
      accent: 'slate',
      sidebarTitle: 'Channels',
      sidebarItems: ['#customer-success', '#partner-intake', '#field-ops', '#ops'],
      filters: ['Pinned', 'Unread'],
      headerActions: ['Search', 'Members'],
      secondaryMeta: ['Shared with Ops', 'Live thread'],
    },
    {
      family: 'team-chat',
      productName: 'Signal Desk',
      workspaceLabel: 'Revenue Team',
      accent: 'teal',
      sidebarTitle: 'Rooms',
      sidebarItems: ['#accounts', '#support', '#onboarding', '#handoffs'],
      filters: ['Mentions', 'Unread'],
      headerActions: ['Search', 'Jump to latest'],
      secondaryMeta: ['Internal', 'Thread view'],
    },
  ],
  article: [
    {
      family: 'article-reader',
      productName: 'Atlas Review',
      workspaceLabel: 'Profiles Desk',
      accent: 'amber',
      sidebarTitle: 'Sections',
      sidebarItems: ['Briefing', 'Summary', 'Key details', 'Context'],
      filters: ['Profiles', 'Research'],
      headerActions: ['Save', 'Share'],
      secondaryMeta: ['Internal memo', 'Published draft'],
    },
    {
      family: 'article-reader',
      productName: 'Briefing Desk',
      workspaceLabel: 'Research',
      accent: 'stone',
      sidebarTitle: 'Outline',
      sidebarItems: ['Lead', 'Summary', 'Details', 'Sources'],
      filters: ['Coverage', 'People'],
      headerActions: ['Export', 'Share'],
      secondaryMeta: ['Reference', 'Ops review'],
    },
  ],
  note: [
    {
      family: 'notes-workspace',
      productName: 'Field Notes',
      workspaceLabel: 'Ops Notebook',
      accent: 'olive',
      sidebarTitle: 'Notebooks',
      sidebarItems: ['Daily intake', 'Customer notes', 'Site visits', 'Reference'],
      filters: ['Pinned', 'Shared'],
      headerActions: ['Tag', 'Move'],
      secondaryMeta: ['Synced', 'Shared with Ops'],
    },
    {
      family: 'notes-workspace',
      productName: 'Notebook Pro',
      workspaceLabel: 'Operations Journal',
      accent: 'sage',
      sidebarTitle: 'Pages',
      sidebarItems: ['Inbox', 'Meetings', 'Requests', 'Reference'],
      filters: ['Updated today', 'Tagged'],
      headerActions: ['Tag', 'Duplicate'],
      secondaryMeta: ['Private', 'Team note'],
    },
  ],
  crm: [
    {
      family: 'crm-record',
      productName: 'Account Hub',
      workspaceLabel: 'Customer Records',
      accent: 'cyan',
      sidebarTitle: 'Views',
      sidebarItems: ['Overview', 'Contacts', 'Activity', 'Timeline'],
      filters: ['Active', 'West'],
      headerActions: ['Edit', 'Assign'],
      secondaryMeta: ['CRM', 'Live data'],
    },
    {
      family: 'crm-record',
      productName: 'Pipeline CRM',
      workspaceLabel: 'Accounts',
      accent: 'sky',
      sidebarTitle: 'Workspace',
      sidebarItems: ['Accounts', 'Contacts', 'Notes', 'Timeline'],
      filters: ['Qualified', 'Active'],
      headerActions: ['Edit', 'Open timeline'],
      secondaryMeta: ['Synced', 'Owned by Ops'],
    },
  ],
  receipt: [
    {
      family: 'receipt-review',
      productName: 'Expense Inbox',
      workspaceLabel: 'Finance review',
      accent: 'stone',
      sidebarTitle: 'Attachments',
      sidebarItems: ['Uploads', 'Needs coding', 'Approved', 'Archive'],
      filters: ['Mobile upload', 'Travel'],
      headerActions: ['Rotate', 'Flag'],
      secondaryMeta: ['Expense queue', 'Receipt scan'],
    },
    {
      family: 'receipt-review',
      productName: 'Receipt Desk',
      workspaceLabel: 'Spend operations',
      accent: 'amber',
      sidebarTitle: 'Batches',
      sidebarItems: ['Today', 'Pending', 'Exceptions', 'Archive'],
      filters: ['Card charge', 'Manual review'],
      headerActions: ['Assign', 'Rotate'],
      secondaryMeta: ['Expense policy', 'Manual coding'],
    },
  ],
};

const TARGET_SURFACES = {
  email: [
    {
      family: 'crm-editor',
      productName: 'Northstar CRM',
      workspaceLabel: 'Contacts',
      titleChoices: ['New contact', 'Create contact record', 'Lead profile'],
      statusChoices: ['Draft', 'New lead', 'Pending review'],
      primaryActionChoices: ['Create contact', 'Save contact', 'Create lead'],
      navItems: ['Contacts', 'Companies', 'Activity'],
      tabs: ['Profile', 'Company', 'Notes'],
      metaFields: ['Owner', 'Queue'],
      sideCardTitle: 'Account summary',
    },
    {
      family: 'support-intake',
      productName: 'Caseboard',
      workspaceLabel: 'Customer intake',
      titleChoices: ['New intake request', 'Customer intake', 'Support intake'],
      statusChoices: ['Open', 'Pending triage', 'Needs review'],
      primaryActionChoices: ['Create case', 'Save intake', 'Open request'],
      navItems: ['Queue', 'Customers', 'Assignments'],
      tabs: ['Details', 'History', 'Notes'],
      metaFields: ['Assignee', 'Priority'],
      sideCardTitle: 'Case details',
    },
  ],
  article: [
    {
      family: 'research-directory',
      productName: 'Speaker Desk',
      workspaceLabel: 'Profiles',
      titleChoices: ['Speaker profile', 'Research contact', 'Profile entry'],
      statusChoices: ['Draft', 'Under review', 'Ready to publish'],
      primaryActionChoices: ['Save profile', 'Create profile', 'Add contact'],
      navItems: ['Profiles', 'Research', 'Review'],
      tabs: ['Overview', 'Contact', 'History'],
      metaFields: ['Desk', 'Reviewer'],
      sideCardTitle: 'Record context',
    },
    {
      family: 'crm-editor',
      productName: 'Press Ledger',
      workspaceLabel: 'Media contacts',
      titleChoices: ['Media contact', 'Profile update', 'Source record'],
      statusChoices: ['Draft', 'Needs review', 'Queued'],
      primaryActionChoices: ['Save record', 'Create contact', 'Update record'],
      navItems: ['Contacts', 'Coverage', 'Notes'],
      tabs: ['Profile', 'Coverage', 'Timeline'],
      metaFields: ['Owner', 'Desk'],
      sideCardTitle: 'Coverage context',
    },
  ],
  note: [
    {
      family: 'event-ops',
      productName: 'Event Ops',
      workspaceLabel: 'Registrations',
      titleChoices: ['Attendee registration', 'Event registration', 'Guest profile'],
      statusChoices: ['Awaiting review', 'Draft', 'Ready to confirm'],
      primaryActionChoices: ['Register attendee', 'Save registration', 'Create registration'],
      navItems: ['Attendees', 'Sessions', 'Assignments'],
      tabs: ['Details', 'Ticketing', 'Notes'],
      metaFields: ['Coordinator', 'Queue'],
      sideCardTitle: 'Registration details',
    },
    {
      family: 'field-intake',
      productName: 'Service Desk',
      workspaceLabel: 'Field requests',
      titleChoices: ['Field intake', 'Site request', 'Visit summary'],
      statusChoices: ['Open', 'Draft', 'Awaiting dispatch'],
      primaryActionChoices: ['Create request', 'Save request', 'Log visit'],
      navItems: ['Requests', 'Dispatch', 'Accounts'],
      tabs: ['Details', 'Location', 'Notes'],
      metaFields: ['Owner', 'Region'],
      sideCardTitle: 'Request context',
    },
  ],
  chat: [
    {
      family: 'recruiting-desk',
      productName: 'Talent Desk',
      workspaceLabel: 'Candidates',
      titleChoices: ['Candidate profile', 'Applicant record', 'Applicant review'],
      statusChoices: ['Screening', 'New', 'Needs review'],
      primaryActionChoices: ['Create profile', 'Save candidate', 'Add applicant'],
      navItems: ['Pipeline', 'Candidates', 'Interviews'],
      tabs: ['Overview', 'Experience', 'Notes'],
      metaFields: ['Recruiter', 'Stage'],
      sideCardTitle: 'Candidate context',
    },
    {
      family: 'customer-onboarding',
      productName: 'Onboarder',
      workspaceLabel: 'Accounts',
      titleChoices: ['Customer application', 'Account setup', 'Onboarding profile'],
      statusChoices: ['In review', 'Pending activation', 'Draft'],
      primaryActionChoices: ['Save application', 'Create account', 'Open onboarding'],
      navItems: ['Accounts', 'Tasks', 'Assignments'],
      tabs: ['Profile', 'Company', 'Access'],
      metaFields: ['Owner', 'Team'],
      sideCardTitle: 'Account context',
    },
  ],
  crm: [
    {
      family: 'vendor-onboarding',
      productName: 'Partner Portal',
      workspaceLabel: 'Vendor setup',
      titleChoices: ['Vendor onboarding', 'Partner setup', 'Account provisioning'],
      statusChoices: ['Pending approval', 'Draft', 'Ready'],
      primaryActionChoices: ['Create vendor', 'Save onboarding', 'Provision account'],
      navItems: ['Vendors', 'Agreements', 'Ops'],
      tabs: ['Company', 'Contacts', 'Compliance'],
      metaFields: ['Owner', 'Region'],
      sideCardTitle: 'Provisioning context',
    },
    {
      family: 'customer-onboarding',
      productName: 'Launchpad',
      workspaceLabel: 'Account activation',
      titleChoices: ['Account activation', 'Partner account', 'Provisioning request'],
      statusChoices: ['Queued', 'Pending', 'Draft'],
      primaryActionChoices: ['Activate account', 'Save request', 'Create account'],
      navItems: ['Accounts', 'Onboarding', 'Queue'],
      tabs: ['Company', 'Contacts', 'Access'],
      metaFields: ['Manager', 'Workspace'],
      sideCardTitle: 'Activation context',
    },
  ],
  receipt: [
    {
      family: 'expense-intake',
      productName: 'Spend Console',
      workspaceLabel: 'Expense reimbursement',
      titleChoices: ['Expense reimbursement', 'Receipt reimbursement', 'Expense entry'],
      statusChoices: ['Needs review', 'Pending coding', 'Draft'],
      primaryActionChoices: ['Submit expense', 'Save reimbursement', 'Create expense'],
      navItems: ['Expenses', 'Cards', 'Approvals'],
      tabs: ['Receipt', 'Coding', 'Policy'],
      metaFields: ['Owner', 'Queue'],
      sideCardTitle: 'Expense policy',
    },
    {
      family: 'expense-intake',
      productName: 'Travel Ledger',
      workspaceLabel: 'Expense intake',
      titleChoices: ['Expense report', 'Travel expense', 'Receipt processing'],
      statusChoices: ['Queued', 'In review', 'Draft'],
      primaryActionChoices: ['Create report', 'Save expense', 'Submit receipt'],
      navItems: ['Reports', 'Receipts', 'Approvals'],
      tabs: ['Receipt', 'Coding', 'Audit'],
      metaFields: ['Reviewer', 'Priority'],
      sideCardTitle: 'Coding guidance',
    },
  ],
};

const FORM_ACCENTS = ['blue', 'indigo', 'teal', 'cyan', 'sky', 'olive', 'sage', 'amber', 'stone'];
const FORM_THEME_MODES = ['light', 'tint', 'dark'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pickSurface(list, rng) {
  return clone(rng.pick(list));
}

function pickMetaValue(label, rng) {
  switch (label) {
    case 'Owner':
    case 'Reviewer':
    case 'Recruiter':
    case 'Coordinator':
    case 'Manager':
      return rng.pick(['Mia Chen', 'Jordan Patel', 'Avery Kim', 'Sam Rivera']);
    case 'Queue':
      return rng.pick(['Inbound', 'Priority', 'Ops', 'Review']);
    case 'Priority':
      return rng.pick(['Normal', 'High', 'Urgent']);
    case 'Desk':
      return rng.pick(['Profiles', 'Coverage', 'Research']);
    case 'Stage':
      return rng.pick(['Screening', 'Review', 'Approved']);
    case 'Team':
      return rng.pick(['Customer Success', 'Platform', 'Revenue Ops']);
    case 'Region':
      return rng.pick(['West', 'Central', 'East']);
    case 'Workspace':
      return rng.pick(['Workspace A', 'Workspace B', 'North America']);
    default:
      return rng.pick(['Active', 'Open', 'Assigned']);
  }
}

function generateInfoSurface(sourceType, spec, rng) {
  const base = pickSurface(SOURCE_SURFACES[sourceType] || SOURCE_SURFACES.note, rng);
  return {
    ...base,
    activeSidebarItem: base.sidebarItems[0],
    activeFilter: base.filters[0] || null,
  };
}

function generateFormSurface(sourceType, spec, form, rng) {
  const base = pickSurface(TARGET_SURFACES[sourceType] || TARGET_SURFACES.note, rng);
  return {
    ...base,
    accent: rng.pick(FORM_ACCENTS),
    themeMode: rng.pick(FORM_THEME_MODES),
    pageTitle: rng.pick(base.titleChoices),
    status: rng.pick(base.statusChoices),
    primaryAction: rng.pick(base.primaryActionChoices),
    meta: base.metaFields.map((label) => ({ label, value: pickMetaValue(label, rng) })),
    activeNavItem: base.navItems[0],
    activeTab: base.tabs[0],
    showAside: form.fields.length >= 10,
  };
}

module.exports = {
  generateInfoSurface,
  generateFormSurface,
};
