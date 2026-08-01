/**
 * Procedural Form Test Generator
 * Generates deterministic benchmark fixtures with realistic window chrome.
 */

const FIRST_NAMES = {
  male: ['James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph', 'Thomas', 'Christopher', 'Daniel', 'Matthew', 'Anthony', 'Mark', 'Donald', 'Steven', 'Andrew', 'Kenneth', 'Joshua', 'Kevin'],
  female: ['Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen', 'Lisa', 'Nancy', 'Betty', 'Margaret', 'Sandra', 'Ashley', 'Kimberly', 'Emily', 'Donna', 'Michelle'],
  neutral: ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Avery', 'Quinn', 'Skyler', 'Drew']
};

const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Chen', 'Patel', 'Kim', 'Nguyen', 'Singh'];

const CITIES = [
  { city: 'Seattle', state: 'WA', zip: '98101' },
  { city: 'Portland', state: 'OR', zip: '97201' },
  { city: 'Austin', state: 'TX', zip: '78701' },
  { city: 'Denver', state: 'CO', zip: '80202' },
  { city: 'Boston', state: 'MA', zip: '02101' },
  { city: 'Chicago', state: 'IL', zip: '60601' },
  { city: 'Atlanta', state: 'GA', zip: '30301' },
  { city: 'Miami', state: 'FL', zip: '33101' },
  { city: 'Phoenix', state: 'AZ', zip: '85001' },
  { city: 'San Francisco', state: 'CA', zip: '94102' },
  { city: 'Los Angeles', state: 'CA', zip: '90001' },
  { city: 'San Diego', state: 'CA', zip: '92101' },
  { city: 'New York', state: 'NY', zip: '10001' },
  { city: 'Philadelphia', state: 'PA', zip: '19101' }
];

const STREETS = ['Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Park Blvd', 'Washington St', 'Broadway', 'Market St', 'Pine Ave', 'Elm St', 'First St', 'Second Ave', 'Third St'];

const COMPANIES = ['TechStart Inc', 'DataVision Corp', 'CloudScale Solutions', 'Innovative Systems', 'Digital Ventures', 'NextGen Technologies', 'Global Dynamics', 'Summit Consulting', 'Apex Industries', 'Quantum Labs', 'Fusion Enterprises', 'Horizon Group', 'Zenith Partners', 'Vertex Solutions', 'Catalyst Innovations'];

const JOB_TITLES = ['Software Engineer', 'Product Manager', 'Senior Developer', 'Marketing Director', 'Sales Representative', 'Data Analyst', 'UX Designer', 'Project Manager', 'Account Executive', 'Operations Manager', 'Business Analyst', 'Customer Success Manager', 'DevOps Engineer', 'Content Strategist'];

const EMAIL_DOMAINS = ['techstart.io', 'datacloud.com', 'innovate.net', 'digital-ventures.com', 'consulting.io', 'globalcorp.com', 'techsolutions.net', 'ventures.co', 'services.com', 'industries.com'];

const INTERESTS = ['Technology', 'Sports', 'Music', 'Reading', 'Travel', 'Photography', 'Cooking', 'Gaming', 'Art', 'Fitness', 'Movies', 'Nature', 'Writing', 'Fashion'];
const COUNTRIES = ['United States', 'Canada', 'United Kingdom', 'Australia', 'Germany', 'France', 'Japan', 'Singapore'];
const CATEGORY_ORDER = ['personal', 'contact', 'professional', 'preferences', 'freeform'];
const CATEGORY_LABELS = {
  personal: 'Personal details',
  contact: 'Contact information',
  professional: 'Professional details',
  preferences: 'Preferences',
  freeform: 'Additional notes',
};

const SOURCE_PRODUCTS = {
  email: ['Relay Mail', 'Inbox Station', 'Pulse Mail'],
  article: ['Briefing Desk', 'Research Digest', 'Atlas Review'],
  note: ['Ops Notebook', 'Field Notes', 'Workspace Notes'],
  chat: ['Orbit Chat', 'Signal Desk', 'Team Thread'],
  crm: ['Pipeline CRM', 'Contact Ledger', 'Account Hub'],
  receipt: ['Expense Inbox', 'Receipt Desk', 'Spend Review'],
};

const FORM_PRODUCTS = ['Nimbus Workspace', 'Operator Console', 'Lead Ops', 'Taskboard Pro', 'Intake Station'];
const NAV_SECTIONS = ['Dashboard', 'Pipeline', 'Accounts', 'Activity', 'Automation', 'Billing', 'Settings'];
const FORM_TABS = ['Overview', 'Profile', 'Contact', 'Review', 'History'];
const INFO_TABS = ['Summary', 'Details', 'Thread', 'Timeline', 'Attachments'];
const APP_BADGES = ['Synced', 'Live', 'Monitored', 'Internal', 'Verified'];
const EXPENSE_CATEGORY_OPTIONS = ['Meals', 'Ground Transport', 'Lodging', 'Office Supplies', 'Parking', 'Client Meeting'];
const RECEIPT_SCENARIOS = [
  {
    merchant: 'Blue Bottle Coffee',
    address: '1 Ferry Building, San Francisco, CA 94111',
    category: 'Meals',
    backgroundScene: 'a modern cafe worktable with a notebook and ceramic mug',
    paymentMethods: ['Visa', 'Mastercard'],
    taxRate: 0.08625,
    tipRange: [2.5, 6.25],
    lineItems: [
      { label: 'Latte', range: [5.25, 6.75] },
      { label: 'Breakfast Sandwich', range: [8.95, 11.75] },
      { label: 'Cold Brew', range: [4.95, 5.95] },
    ],
  },
  {
    merchant: 'Staples',
    address: '777 Market St, San Francisco, CA 94103',
    category: 'Office Supplies',
    backgroundScene: 'an office desk with a keyboard, pen, and closed laptop',
    paymentMethods: ['Mastercard', 'Visa'],
    taxRate: 0.08625,
    tipRange: [0, 0],
    lineItems: [
      { label: 'Notebook Set', range: [11.99, 16.99] },
      { label: 'Pens', range: [6.49, 9.49] },
      { label: 'USB-C Cable', range: [14.99, 19.99] },
    ],
  },
  {
    merchant: 'Hilton Garden Inn',
    address: '1100 5th Ave, Seattle, WA 98101',
    category: 'Lodging',
    backgroundScene: 'a hotel desk with a room key sleeve, planner, and soft lamp light',
    paymentMethods: ['AmEx', 'Visa'],
    taxRate: 0.148,
    tipRange: [0, 0],
    lineItems: [
      { label: 'Room Charge', range: [189.00, 249.00] },
      { label: 'Parking', range: [26.00, 38.00] },
    ],
  },
  {
    merchant: 'Lyft',
    address: '588 Brannan St, San Francisco, CA 94107',
    category: 'Ground Transport',
    backgroundScene: 'a commuter desk with transit card, headphones, and daylight',
    paymentMethods: ['Visa', 'Mastercard'],
    taxRate: 0,
    tipRange: [0, 4.5],
    lineItems: [
      { label: 'Ride Charge', range: [24.50, 46.75] },
      { label: 'Service Fee', range: [3.25, 6.95] },
    ],
  },
];

const FIELD_CATEGORIES = {
  personal: {
    'First Name': { type: 'text', generator: (data) => ensurePersonIdentity(data).firstName },
    'Last Name': { type: 'text', generator: (data) => ensurePersonIdentity(data).lastName },
    'Full Name': { type: 'text', generator: (data) => ensurePersonIdentity(data).fullName },
    'Date of Birth': { type: 'date', generator: (_data, rng) => randomDate(1950, 2005, rng) },
    Age: { type: 'number', generator: (_data, rng) => String(randomInt(18, 75, rng)) },
    Gender: { type: 'radio', options: ['Male', 'Female', 'Other', 'Prefer not to say'], generator: (_data, rng) => pickRandom(['Male', 'Female', 'Other'], rng) }
  },
  contact: {
    Email: { type: 'email', generator: (data, rng) => {
      const identity = ensurePersonIdentity(data);
      return generateEmail(identity.firstName, identity.lastName, rng);
    } },
    'Email Address': { type: 'email', generator: (data, rng) => {
      const identity = ensurePersonIdentity(data);
      return generateEmail(identity.firstName, identity.lastName, rng);
    } },
    Phone: { type: 'tel', generator: (_data, rng) => generatePhone(rng) },
    'Phone Number': { type: 'tel', generator: (_data, rng) => generatePhone(rng) },
    Mobile: { type: 'tel', generator: (_data, rng) => generatePhone(rng) },
    Address: { type: 'text', generator: (_data, rng) => `${randomInt(100, 9999, rng)} ${pickRandom(STREETS, rng)}` },
    'Street Address': { type: 'text', generator: (_data, rng) => `${randomInt(100, 9999, rng)} ${pickRandom(STREETS, rng)}` },
    'Apartment/Unit': { type: 'text', generator: (_data, rng) => rng.chance(0.45) ? `Unit ${randomInt(1, 20, rng)}${pickRandom(['A', 'B', 'C', ''], rng)}` : '' },
    City: { type: 'text', generator: (_data, rng) => pickRandom(CITIES, rng).city },
    State: { type: 'text', generator: (data, rng) => data._locationData ? data._locationData.state : pickRandom(CITIES, rng).state },
    'ZIP Code': { type: 'text', generator: (data, rng) => data._locationData ? data._locationData.zip : pickRandom(CITIES, rng).zip },
    Country: { type: 'select', options: COUNTRIES, generator: () => 'United States' }
  },
  professional: {
    Company: { type: 'text', generator: (_data, rng) => pickRandom(COMPANIES, rng) },
    'Company Name': { type: 'text', generator: (_data, rng) => pickRandom(COMPANIES, rng) },
    'Job Title': { type: 'text', generator: (_data, rng) => pickRandom(JOB_TITLES, rng) },
    Position: { type: 'text', generator: (_data, rng) => pickRandom(JOB_TITLES, rng) },
    Department: { type: 'select', options: ['Engineering', 'Sales', 'Marketing', 'Operations', 'HR', 'Finance'], generator: (_data, rng) => pickRandom(['Engineering', 'Sales', 'Marketing', 'Operations'], rng) },
    'Years of Experience': { type: 'number', generator: (_data, rng) => String(randomInt(0, 25, rng)) },
    'LinkedIn Profile': { type: 'url', generator: (data) => {
      const identity = ensurePersonIdentity(data);
      return `https://linkedin.com/in/${identity.firstName.toLowerCase()}-${identity.lastName.toLowerCase()}`;
    } }
  },
  preferences: {
    Newsletter: { type: 'radio', options: ['Yes', 'No'], generator: (_data, rng) => pickRandom(['Yes', 'No'], rng) },
    'Contact Method': { type: 'radio', options: ['Email', 'Phone', 'Text'], generator: (_data, rng) => pickRandom(['Email', 'Phone'], rng) },
    'Preferred Language': { type: 'select', options: ['English', 'Spanish', 'French', 'German', 'Chinese'], generator: () => 'English' },
    Interests: { type: 'checkbox', options: INTERESTS.slice(0, 6), generator: (_data, rng) => shuffle(INTERESTS, rng).slice(0, randomInt(2, 4, rng)) }
  },
  freeform: {
    Comments: { type: 'textarea', generator: (_data, rng) => pickRandom([
      'Looking forward to connecting with your team.',
      'Interested in learning more about partnership opportunities.',
      'Please reach out with more information.',
      'Excited to explore potential collaboration.',
      'Would like to discuss this further.'
    ], rng) },
    'Additional Information': { type: 'textarea', generator: () => '' },
    Message: { type: 'textarea', generator: (_data, rng) => pickRandom([
      'Thank you for your time and consideration.',
      'Looking forward to hearing from you soon.',
      'Please let me know if you need any additional information.'
    ], rng) }
  }
};

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function hash() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a) {
  return function random() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createRng(seed) {
  const seedString = String(seed);
  const seedHash = xmur3(seedString)();
  const random = mulberry32(seedHash);

  return {
    seed: seedString,
    float() {
      return random();
    },
    int(min, max) {
      return Math.floor(random() * (max - min + 1)) + min;
    },
    chance(probability) {
      return random() < probability;
    },
    pick(values) {
      return values[Math.floor(random() * values.length)];
    },
    shuffle(values) {
      const shuffled = [...values];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
      }
      return shuffled;
    },
    fork(label) {
      return createRng(`${seedString}:${label}`);
    }
  };
}

function pickRandom(arr, rng) {
  return rng.pick(arr);
}

function randomInt(min, max, rng) {
  return rng.int(min, max);
}

function shuffle(arr, rng) {
  return rng.shuffle(arr);
}

function randomDate(startYear, endYear, rng) {
  const year = randomInt(startYear, endYear, rng);
  const month = String(randomInt(1, 12, rng)).padStart(2, '0');
  const day = String(randomInt(1, 28, rng)).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function generateEmail(firstName, lastName, rng) {
  const fn = (firstName || pickRandom([...FIRST_NAMES.male, ...FIRST_NAMES.female], rng)).toLowerCase();
  const ln = (lastName || pickRandom(LAST_NAMES, rng)).toLowerCase();
  const domain = pickRandom(EMAIL_DOMAINS, rng);

  const patterns = [
    `${fn}.${ln}@${domain}`,
    `${fn}${ln}@${domain}`,
    `${fn[0]}${ln}@${domain}`,
    `${fn}@${domain}`
  ];

  return pickRandom(patterns, rng);
}

function generatePhone(rng) {
  const areaCode = randomInt(200, 999, rng);
  const prefix = randomInt(200, 999, rng);
  const line = randomInt(1000, 9999, rng);

  const formats = [
    `${areaCode}-${prefix}-${line}`,
    `(${areaCode}) ${prefix}-${line}`,
    `${areaCode}.${prefix}.${line}`
  ];

  return pickRandom(formats, rng);
}

function formatReceiptDate(date) {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${month}/${day}/${date.getUTCFullYear()}`;
}

function formatReceiptTime(date) {
  const hours = date.getUTCHours();
  const normalizedHours = hours % 12 || 12;
  const meridiem = hours >= 12 ? 'PM' : 'AM';
  return `${normalizedHours}:${String(date.getUTCMinutes()).padStart(2, '0')} ${meridiem}`;
}

function toMoneyString(value) {
  return Number(value).toFixed(2);
}

function randomMoney(min, max, rng) {
  const cents = rng.int(Math.round(min * 100), Math.round(max * 100));
  return cents / 100;
}

function ensurePersonIdentity(data) {
  if (!data._personIdentity) {
    const firstName = pickRandom([...FIRST_NAMES.male, ...FIRST_NAMES.female, ...FIRST_NAMES.neutral], data._rng);
    const lastName = pickRandom(LAST_NAMES, data._rng);
    data._personIdentity = {
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
    };
  }

  data.firstName = data._personIdentity.firstName;
  data.lastName = data._personIdentity.lastName;
  data.fullName = data._personIdentity.fullName;
  return data._personIdentity;
}

function formatMonthName(monthIndex) {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthIndex];
}

function formatShortDate(date) {
  return `${formatMonthName(date.getUTCMonth())} ${String(date.getUTCDate()).padStart(2, '0')}, ${date.getUTCFullYear()}`;
}

function formatNumericDate(date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

function formatTimestamp(date) {
  const hours = date.getUTCHours();
  const normalizedHours = hours % 12 || 12;
  const meridiem = hours >= 12 ? 'PM' : 'AM';
  return `${normalizedHours}:${String(date.getUTCMinutes()).padStart(2, '0')} ${meridiem}`;
}

function createScenarioContext(rng) {
  const month = rng.int(0, 11);
  const day = rng.int(1, 28);
  const hour = rng.int(8, 17);
  const minute = rng.int(0, 59);
  const baseDate = new Date(Date.UTC(2026, month, day, hour, minute, 0));
  const channel = pickRandom(['#revops', '#customer-success', '#partner-intake', '#field-ops'], rng);

  return {
    baseDate,
    shortDate: formatShortDate(baseDate),
    numericDate: formatNumericDate(baseDate),
    channel,
    crmId: String(rng.int(10000, 99999)),
    articleDesk: pickRandom(['Profiles', 'Operations', 'People', 'Coverage'], rng),
    noteOwner: `${pickRandom([...FIRST_NAMES.male, ...FIRST_NAMES.female], rng)} ${pickRandom(LAST_NAMES, rng)}`,
  };
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function buildReceiptLineItems(scenario, complexity, rng) {
  const baseItems = shuffle(scenario.lineItems, rng);
  const targetCount = complexity === 'complex' ? Math.min(baseItems.length, 3) : 2;
  return baseItems.slice(0, targetCount).map((item) => ({
    label: item.label,
    amount: roundMoney(randomMoney(item.range[0], item.range[1], rng)),
  }));
}

function createReceiptValues(complexity, rng) {
  const scenario = pickRandom(RECEIPT_SCENARIOS, rng);
  const purchaseDate = new Date(Date.UTC(2026, rng.int(0, 11), rng.int(1, 28), rng.int(8, 18), rng.int(0, 59), 0));
  const lineItems = buildReceiptLineItems(scenario, complexity, rng);
  const subtotal = roundMoney(lineItems.reduce((sum, item) => sum + item.amount, 0));
  const taxAmount = roundMoney(subtotal * scenario.taxRate);
  const tipBounds = scenario.tipRange || [0, 0];
  const tipAmount = tipBounds[1] > 0 ? roundMoney(randomMoney(tipBounds[0], tipBounds[1], rng)) : 0;
  const totalAmount = roundMoney(subtotal + taxAmount + tipAmount);
  const paymentMethod = pickRandom(scenario.paymentMethods, rng);
  const cardLastFour = String(rng.int(1000, 9999));
  const receiptNumber = String(rng.int(100000, 999999));
  const approvalCode = `${rng.int(100000, 999999)}`;

  return {
    scenario,
    receiptNumber,
    approvalCode,
    purchaseDateDisplay: formatReceiptDate(purchaseDate),
    purchaseTime: formatReceiptTime(purchaseDate),
    merchant: scenario.merchant,
    address: scenario.address,
    expenseCategory: scenario.category,
    paymentMethod,
    cardLastFour,
    subtotal,
    taxAmount,
    tipAmount,
    totalAmount,
    lineItems,
  };
}

function createReceiptForm(complexity, rng) {
  const receipt = createReceiptValues(complexity, rng);
  const fieldSpecs = [
    {
      id: 'input-expense-merchant',
      label: 'Merchant',
      type: 'text',
      category: 'expense',
      sectionTitle: 'Receipt details',
      required: true,
      value: receipt.merchant,
    },
    {
      id: 'input-purchase-date',
      label: 'Purchase Date',
      type: 'text',
      category: 'expense',
      sectionTitle: 'Receipt details',
      required: true,
      value: receipt.purchaseDateDisplay,
    },
    {
      id: 'input-amount-charged',
      label: 'Amount Charged',
      type: 'text',
      category: 'expense',
      sectionTitle: 'Receipt details',
      required: true,
      value: toMoneyString(receipt.totalAmount),
    },
    {
      id: 'input-expense-category',
      label: 'Expense Category',
      type: 'select',
      category: 'expense',
      sectionTitle: 'Accounting',
      required: true,
      options: EXPENSE_CATEGORY_OPTIONS,
      value: receipt.expenseCategory,
    },
    {
      id: 'input-payment-method',
      label: 'Payment Method',
      type: 'select',
      category: 'accounting',
      sectionTitle: 'Accounting',
      required: complexity === 'complex',
      options: ['Visa', 'Mastercard', 'AmEx', 'Cash'],
      value: receipt.paymentMethod,
    },
    {
      id: 'input-card-last-four',
      label: 'Card Last Four',
      type: 'text',
      category: 'accounting',
      sectionTitle: 'Accounting',
      required: complexity === 'complex',
      value: receipt.cardLastFour,
    },
    {
      id: 'input-tax-amount',
      label: 'Tax Amount',
      type: 'text',
      category: 'accounting',
      sectionTitle: 'Accounting',
      required: complexity === 'complex',
      value: toMoneyString(receipt.taxAmount),
    },
  ];

  const maxFields = complexity === 'complex' ? 7 : 4;
  const selectedSpecs = fieldSpecs.slice(0, maxFields);
  const form = {
    title: 'Expense Reimbursement',
    fields: selectedSpecs.map((field) => ({
      ...chooseFieldPresentation(field.type, rng),
      id: field.id,
      label: field.label,
      type: field.type,
      category: field.category,
      sectionTitle: field.sectionTitle,
      required: field.required,
      ...(field.options ? { options: field.options } : {}),
    })),
    layout: 'single',
    selectVariant: rng.chance(0.5) ? 'native' : 'web',
  };

  const generatedData = {};
  for (const field of selectedSpecs) {
    generatedData[field.id] = field.value;
  }

  return { form, generatedData, receipt };
}

function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return String(value);
}

function chooseFieldPresentation(fieldType, rng) {
  const size = fieldType === 'textarea'
    ? pickRandom(['regular', 'large'], rng)
    : pickRandom(['compact', 'regular', 'large'], rng);

  const fullWidth = fieldType === 'textarea'
    || fieldType === 'checkbox'
    || fieldType === 'radio'
    || rng.chance(
      fieldType === 'text' || fieldType === 'email' || fieldType === 'url' || fieldType === 'tel'
        ? 0.28
        : 0.18,
    );

  return {
    size,
    fullWidth,
    rows: fieldType === 'textarea' ? randomInt(3, 7, rng) : undefined,
  };
}

function hasUsableSourceValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function ensureRequiredFieldValue(field, generatedData, rng) {
  if (hasUsableSourceValue(generatedData[field.id])) {
    return;
  }

  switch (field.type) {
    case 'textarea':
      generatedData[field.id] = field.label === 'Additional Information'
        ? 'Please use the primary contact details already provided.'
        : 'Please follow up using the visible source details.';
      break;
    case 'select':
    case 'radio':
      generatedData[field.id] = Array.isArray(field.options) && field.options.length > 0 ? field.options[0] : 'Option 1';
      break;
    case 'checkbox':
      generatedData[field.id] = Array.isArray(field.options) && field.options.length > 0 ? [field.options[0]] : ['Selected'];
      break;
    case 'number':
      generatedData[field.id] = String(randomInt(1, 25, rng));
      break;
    case 'date':
      generatedData[field.id] = randomDate(1980, 2026, rng);
      break;
    case 'email': {
      const identity = ensurePersonIdentity(generatedData);
      generatedData[field.id] = generateEmail(identity.firstName, identity.lastName, rng);
      break;
    }
    case 'tel':
      generatedData[field.id] = generatePhone(rng);
      break;
    case 'url': {
      const identity = ensurePersonIdentity(generatedData);
      generatedData[field.id] = `https://example.com/${identity.firstName.toLowerCase()}-${identity.lastName.toLowerCase()}`;
      break;
    }
    default:
      if (field.label === 'Apartment/Unit') {
        generatedData[field.id] = `Unit ${randomInt(1, 20, rng)}`;
      } else if (field.label === 'Address' || field.label === 'Street Address') {
        generatedData[field.id] = `${randomInt(100, 9999, rng)} ${pickRandom(STREETS, rng)}`;
      } else {
        generatedData[field.id] = `${field.label} ${randomInt(1, 99, rng)}`;
      }
      break;
  }
}

function chooseFieldsToInclude(form, generatedData, infoAvailability, rng) {
  const supportedFields = form.fields.filter((field) => hasUsableSourceValue(generatedData[field.id]));
  const totalFields = supportedFields.length;
  if (totalFields === 0) {
    return [];
  }
  if (infoAvailability === 'complete' || infoAvailability === 'excessive') {
    return [...supportedFields];
  }

  const ratio = infoAvailability === 'partial'
    ? 0.5 + rng.float() * 0.3
    : 0.2 + rng.float() * 0.3;
  const requiredFields = supportedFields.filter((field) => field.required);
  const count = Math.max(1, requiredFields.length, Math.floor(totalFields * ratio));

  const optionalFields = shuffle(supportedFields.filter((field) => !field.required), rng);
  const selected = [];

  for (const field of requiredFields) {
    selected.push(field);
  }

  for (const field of optionalFields) {
    if (selected.length >= count) {
      break;
    }
    if (!selected.includes(field)) {
      selected.push(field);
    }
  }

  return selected;
}

function createFieldFactItems(fields, data) {
  return fields
    .filter((field) => data[field.id] !== undefined && data[field.id] !== '')
    .map((field) => ({
      type: 'fact',
      fieldId: field.id,
      label: field.required ? `${field.label} * required` : field.label,
      value: normalizeValue(data[field.id]),
    }));
}

function buildFieldNarratives(fields, data, excessive, rng, style = 'email') {
  const items = [];

  for (const field of fields) {
    const value = data[field.id];
    if (value === undefined || value === '') {
      continue;
    }

    const displayValue = normalizeValue(value);

    if (style === 'chat') {
      items.push({
        fieldId: field.id,
        text: `${field.label}: ${displayValue}`,
      });
      continue;
    }

    let text;
    if (field.label === 'Full Name') {
      text = `The contact's full name is ${displayValue}.`;
    } else if (field.label === 'First Name') {
      text = `The first name on file is ${displayValue}.`;
    } else if (field.label === 'Last Name') {
      text = `The last name on file is ${displayValue}.`;
    } else if (field.label.includes('Email')) {
      text = `You can reach them at ${displayValue}.`;
    } else if (field.label.includes('Phone')) {
      text = `Their phone number is ${displayValue}.`;
    } else if (field.label.includes('Mobile')) {
      text = `Mobile: ${displayValue}.`;
    } else if (field.label.includes('Company')) {
      text = `They work for ${displayValue}.`;
    } else if (field.label.includes('Address')) {
      text = `The address on record is ${displayValue}.`;
    } else if (field.label === 'City') {
      text = `They are based in ${displayValue}.`;
    } else if (field.label === 'Job Title' || field.label === 'Position') {
      text = `Their role is ${displayValue}.`;
    } else {
      text = `${field.label}: ${displayValue}.`;
    }

    items.push({ fieldId: field.id, text });
  }

  if (excessive && style !== 'chat') {
    items.push({
      text: `Additional context: this record is associated with ${pickRandom(['a recent launch', 'a partner handoff', 'an events follow-up', 'a quarterly review'], rng)}.`,
    });
  }

  return items;
}

function generateEmailSource(fields, data, excessive, noiseLevel, context, rng) {
  const sender = `${pickRandom(['Sarah Mitchell', 'John Park', 'Alex Rivera', 'Morgan Lee'], rng)} <${pickRandom(['ops', 'support', 'revops', 'intake'], rng)}@${pickRandom(EMAIL_DOMAINS, rng)}>`;
  const subject = pickRandom([
    'New contact information to enter',
    'Customer details for registration',
    'Updated profile details',
    'Please add this information',
    'Lead intake details'
  ], rng);

  const prose = buildFieldNarratives(fields, data, excessive, rng);
  const followUp = noiseLevel === 'low'
    ? []
    : [
        {
          type: 'bullet',
          text: pickRandom([
            'Route this to the onboarding queue after entry.',
            'This came through a partner referral.',
            'The customer asked for a quick turnaround.',
            'The account team needs this added before tomorrow.'
          ], rng),
        },
        {
          type: 'bullet',
          text: pickRandom([
            'No attachments were included.',
            'This thread is still active.',
            'The sender mentioned a follow-up next week.',
            'This should stay in the active queue.'
          ], rng),
        },
      ];

  return {
    title: subject,
    subtitle: 'Inbound message',
    meta: [
      { label: 'From', value: sender },
      { label: 'To', value: 'ops@workspace.local' },
      { label: 'Date', value: context.shortDate },
      { label: 'Thread', value: `MSG-${context.crmId}` },
    ],
    sections: [
      {
        title: 'Message',
        items: [
          {
            type: 'paragraph',
            text: pickRandom([
              'Hi team, please add this contact to the system.',
              'Could you enter the following details into the customer record?',
              'Sharing the intake details from the message below.',
            ], rng),
          },
          ...prose.map((item) => ({ type: 'paragraph', fieldId: item.fieldId, text: item.text })),
        ],
      },
      {
        title: 'Forwarded details',
        items: createFieldFactItems(fields, data),
      },
      {
        title: 'Thread notes',
        items: followUp,
      },
    ].filter((section) => section.items.length > 0),
  };
}

function generateArticleSource(fields, data, excessive, noiseLevel, context, rng) {
  const person = ensurePersonIdentity(data);
  const highlightText = pickRandom([
    'The operations team prepared this profile for internal intake review.',
    'This summary was assembled from the latest briefing packet.',
    'The profile below was pulled into the research queue this morning.'
  ], rng);

  const contextBullets = [];
  if (noiseLevel !== 'low') {
    contextBullets.push({ type: 'bullet', text: `Coverage desk: ${context.articleDesk}` });
    contextBullets.push({ type: 'bullet', text: `Prepared on ${context.numericDate}` });
  }
  if (excessive) {
    contextBullets.push({ type: 'bullet', text: `Background interest: ${pickRandom(['product launches', 'field marketing', 'regional expansion', 'customer success'], rng)}` });
  }

  return {
    title: pickRandom([
      'Featured professional profile',
      'Industry spotlight',
      'Member profile',
      'Internal briefing dossier'
    ], rng),
    subtitle: `${person.fullName} overview`,
    meta: [
      { label: 'Published', value: context.shortDate },
      { label: 'Desk', value: context.articleDesk },
      { label: 'Status', value: 'Ready for review' },
    ],
    sections: [
      {
        title: 'Summary',
        items: [
          { type: 'paragraph', text: `${highlightText} ${person.fullName} is the subject of this profile.` },
          ...buildFieldNarratives(fields, data, excessive, rng, 'article').map((item) => ({
            type: 'paragraph',
            fieldId: item.fieldId,
            text: item.text,
          })),
        ],
      },
      {
        title: 'Key details',
        items: createFieldFactItems(fields, data),
      },
      {
        title: 'Context',
        items: contextBullets,
      },
    ].filter((section) => section.items.length > 0),
  };
}

function generateNoteSource(fields, data, excessive, noiseLevel, context, rng) {
  const checklist = [];
  if (noiseLevel !== 'low') {
    checklist.push({ type: 'bullet', text: 'Loop in the assigned coordinator after the record is updated.' });
    checklist.push({ type: 'bullet', text: 'Attach the follow-up packet if this moves forward.' });
  }
  if (excessive) {
    checklist.push({ type: 'bullet', text: `Timezone note: ${pickRandom(['Pacific', 'Mountain', 'Central', 'Eastern'], rng)}` });
  }

  return {
    title: pickRandom(['Contact intake note', 'Registration memo', 'Customer details note', 'Processing note'], rng),
    subtitle: `Owner: ${context.noteOwner}`,
    meta: [
      { label: 'Created', value: context.shortDate },
      { label: 'Queue', value: 'Ops intake' },
      { label: 'Priority', value: noiseLevel === 'high' ? 'High' : 'Normal' },
    ],
    sections: [
      {
        title: 'Property sheet',
        items: createFieldFactItems(fields, data),
      },
      {
        title: 'Checklist',
        items: checklist,
      },
      {
        title: 'Summary',
        items: buildFieldNarratives(fields, data, excessive, rng).slice(0, 4).map((item) => ({
          type: 'paragraph',
          fieldId: item.fieldId,
          text: item.text,
        })),
      },
    ].filter((section) => section.items.length > 0),
  };
}

function generateChatSource(fields, data, excessive, noiseLevel, context, rng) {
  const participants = shuffle(['Alex', 'Jordan', 'Sam', 'Casey', 'Taylor', 'Morgan'], rng).slice(0, 2);
  const [user, teammate] = participants;
  const baseTime = new Date(context.baseDate.getTime());

  function timeWithOffset(minutesOffset) {
    const value = new Date(baseTime.getTime() + minutesOffset * 60000);
    return formatTimestamp(value);
  }

  const messages = [];
  if (noiseLevel !== 'low') {
    messages.push({ type: 'message', speaker: teammate, time: timeWithOffset(-12), text: 'Did the new intake details come through yet?' });
  }
  messages.push({ type: 'message', speaker: user, time: timeWithOffset(-8), text: 'Yes. Adding the visible details here.' });
  for (const item of buildFieldNarratives(fields, data, false, rng, 'chat')) {
    messages.push({ type: 'message', fieldId: item.fieldId, speaker: user, time: timeWithOffset(-6), text: item.text });
  }
  if (excessive) {
    messages.push({
      type: 'message',
      speaker: teammate,
      time: timeWithOffset(-2),
      text: `Also, this came from ${pickRandom(['the website', 'a partner intro', 'a sales follow-up'], rng)}. Add it to the normal queue after the profile is set up.`,
    });
  }

  return {
    title: 'Team conversation',
    subtitle: context.channel,
    meta: [
      { label: 'Channel', value: context.channel },
      { label: 'Members', value: participants.join(', ') },
      { label: 'Updated', value: context.shortDate },
    ],
    sections: [
      {
        title: 'Messages',
        items: messages,
      },
    ],
  };
}

function generateCRMSource(fields, data, excessive, noiseLevel, context, rng) {
  const notes = [];
  if (noiseLevel !== 'low') {
    notes.push({ type: 'bullet', text: 'Initial contact made. Follow-up scheduled.' });
  }
  if (excessive) {
    notes.push({ type: 'bullet', text: `Lead source: ${pickRandom(['Website', 'Referral', 'Conference', 'Cold call'], rng)}` });
    notes.push({ type: 'bullet', text: `Assigned owner: ${pickRandom([...FIRST_NAMES.male, ...FIRST_NAMES.female], rng)} ${pickRandom(LAST_NAMES, rng)}` });
  }

  return {
    title: 'Contact record',
    subtitle: `Record ${context.crmId}`,
    meta: [
      { label: 'Record ID', value: context.crmId },
      { label: 'Status', value: 'Active' },
      { label: 'Updated', value: context.shortDate },
    ],
    sections: [
      {
        title: 'Primary information',
        items: createFieldFactItems(fields, data),
      },
      {
        title: 'Notes',
        items: notes,
      },
    ].filter((section) => section.items.length > 0),
  };
}

function generateReceiptSource(fields, formData, rng) {
  const receipt = formData.receipt;
  const fieldIds = fields.map((field) => field.id);
  return {
    title: 'Uploaded expense receipt',
    subtitle: 'Mobile capture pending review',
    meta: [
      { label: 'Queue', value: 'Expense inbox' },
      { label: 'Channel', value: 'Travel reimbursement' },
      { label: 'Attachment', value: 'Receipt image' },
    ],
    imageLabel: 'Uploaded receipt image',
    imageFieldIds: fieldIds,
    summaryLines: [
      `Merchant: ${receipt.merchant}`,
      `Purchase date: ${receipt.purchaseDateDisplay}`,
      `Amount charged: ${toMoneyString(receipt.totalAmount)}`,
      `Expense category: ${receipt.expenseCategory}`,
      `Payment method: ${receipt.paymentMethod}`,
      `Card last four: ${receipt.cardLastFour}`,
      `Tax amount: ${toMoneyString(receipt.taxAmount)}`,
    ],
    receiptAsset: {
      merchant: receipt.merchant,
      address: receipt.address,
      purchaseDateDisplay: receipt.purchaseDateDisplay,
      purchaseTime: receipt.purchaseTime,
      receiptNumber: receipt.receiptNumber,
      approvalCode: receipt.approvalCode,
      paymentMethod: receipt.paymentMethod,
      cardLastFour: receipt.cardLastFour,
      subtotal: receipt.subtotal,
      taxAmount: receipt.taxAmount,
      tipAmount: receipt.tipAmount,
      totalAmount: receipt.totalAmount,
      lineItems: receipt.lineItems,
      backgroundScene: receipt.scenario.backgroundScene,
    },
    sections: [
      {
        title: 'Review notes',
        items: [
          { type: 'bullet', text: 'Read the uploaded receipt image to capture the merchant, purchase date, and charged amount.' },
          { type: 'bullet', text: 'Infer the expense category from the merchant and line items when the form asks for it.' },
        ],
      },
    ],
  };
}

function generateSourceDocument(sourceType, formData, infoAvailability, noiseLevel, rng) {
  const { form, generatedData } = formData;
  if (sourceType === 'receipt') {
    const receiptFields = [...form.fields];
    const document = generateReceiptSource(receiptFields, formData, rng.fork('receipt'));
    const expectedValues = {};
    for (const field of receiptFields) {
      if (generatedData[field.id] !== undefined && generatedData[field.id] !== '') {
        expectedValues[field.id] = generatedData[field.id];
      }
    }

    return {
      type: sourceType,
      document,
      expectedValues,
    };
  }

  const fieldsToInclude = chooseFieldsToInclude(form, generatedData, infoAvailability, rng);
  const context = createScenarioContext(rng.fork('scenario'));

  let document;
  switch (sourceType) {
    case 'email':
      document = generateEmailSource(fieldsToInclude, generatedData, infoAvailability === 'excessive', noiseLevel, context, rng.fork('email'));
      break;
    case 'article':
      document = generateArticleSource(fieldsToInclude, generatedData, infoAvailability === 'excessive', noiseLevel, context, rng.fork('article'));
      break;
    case 'note':
      document = generateNoteSource(fieldsToInclude, generatedData, infoAvailability === 'excessive', noiseLevel, context, rng.fork('note'));
      break;
    case 'chat':
      document = generateChatSource(fieldsToInclude, generatedData, infoAvailability === 'excessive', noiseLevel, context, rng.fork('chat'));
      break;
    case 'crm':
      document = generateCRMSource(fieldsToInclude, generatedData, infoAvailability === 'excessive', noiseLevel, context, rng.fork('crm'));
      break;
    default:
      document = generateNoteSource(fieldsToInclude, generatedData, infoAvailability === 'excessive', noiseLevel, context, rng.fork('note'));
      break;
  }

  const expectedValues = {};
  for (const field of fieldsToInclude) {
    if (generatedData[field.id] !== undefined && generatedData[field.id] !== '') {
      expectedValues[field.id] = generatedData[field.id];
    }
  }

  return {
    type: sourceType,
    document,
    expectedValues,
  };
}

function generateNavigationItems(count, rng, activeLabel) {
  const items = shuffle(NAV_SECTIONS, rng).slice(0, count).map((label) => ({
    label,
    active: label === activeLabel,
    badge: rng.chance(0.25) ? String(rng.int(2, 19)) : '',
  }));

  if (!items.some((item) => item.active) && items.length > 0) {
    items[0].active = true;
    items[0].label = activeLabel;
  }

  return items;
}

function generateTabs(tabPool, count, rng, activeLabel) {
  const tabs = shuffle(tabPool, rng).slice(0, count).map((label) => ({
    label,
    active: label === activeLabel,
  }));
  if (!tabs.some((tab) => tab.active)) {
    tabs.unshift({ label: activeLabel, active: true });
    return tabs.slice(0, count);
  }
  return tabs;
}

function generateShell(windowType, spec, rng) {
  const isInfo = windowType === 'info';
  const noise = spec.noiseLevel;
  const sidebarCount = noise === 'high' ? 6 : noise === 'medium' ? 5 : 4;
  const tabCount = noise === 'high' ? 4 : 3;
  const activeNav = isInfo ? 'Pipeline' : 'Accounts';
  const activeTab = isInfo ? 'Summary' : 'Profile';

  const brand = isInfo
    ? pickRandom(SOURCE_PRODUCTS[spec.sourceType], rng)
    : pickRandom(FORM_PRODUCTS, rng);

  const subtitle = isInfo
    ? pickRandom(['Inbound review', 'Record summary', 'Context panel', 'Intake source'], rng)
    : pickRandom(['Entry workspace', 'Profile editor', 'Submission flow', 'Case intake'], rng);

  const badges = shuffle(APP_BADGES, rng).slice(0, noise === 'low' ? 1 : 2);
  const railCount = noise === 'high' ? 4 : noise === 'medium' ? 3 : 2;
  const railTitle = isInfo ? 'Activity' : 'Runbook';
  const railItems = [];
  for (let index = 0; index < railCount; index += 1) {
    railItems.push(
      isInfo
        ? pickRandom([
            'Recent import queued',
            'Internal note pending review',
            'Record synced to workspace',
            'Reference packet attached',
            'Channel mirror updated'
          ], rng)
        : pickRandom([
            'Draft changes sync every few minutes',
            'Owner notifications are enabled',
            'Recent edits appear in activity history',
            'Team routing happens after save',
            'Custom field options update automatically'
          ], rng)
    );
  }

  return {
    brand,
    subtitle,
    breadcrumbs: isInfo ? ['Workspace', 'Sources', spec.sourceType.toUpperCase()] : ['Workspace', 'Intake', spec.complexity.toUpperCase()],
    tabs: generateTabs(isInfo ? INFO_TABS : FORM_TABS, tabCount, rng, activeTab),
    navItems: generateNavigationItems(sidebarCount, rng, activeNav),
    statusBadges: badges,
    toolbarActions: shuffle(isInfo ? ['Search', 'Archive', 'Assign', 'Pin'] : ['Save Draft', 'Assign', 'Review', 'Duplicate'], rng).slice(0, noise === 'low' ? 2 : 3),
    searchPlaceholder: isInfo ? 'Search records or messages' : 'Search fields or actions',
    railTitle,
    railItems,
    showSidebar: true,
    showMetrics: noise !== 'low',
    metrics: noise === 'low'
      ? []
      : shuffle(isInfo ? ['Queue: 12', 'Coverage: West', 'Unread: 3'] : ['Tasks: 4', 'Queue: 9', 'Owner: Ops'], rng).slice(0, noise === 'high' ? 3 : 2),
  };
}

function generateForm(complexity, rng) {
  return generateFormForSource(complexity, 'default', rng);
}

function generateFormForSource(complexity, sourceType, rng) {
  if (sourceType === 'receipt') {
    return createReceiptForm(complexity, rng);
  }

  const fieldCounts = {
    simple: [2, 4],
    medium: [5, 8],
    complex: [9, 15]
  };

  const [min, max] = fieldCounts[complexity] || fieldCounts.medium;
  const numFields = randomInt(min, max, rng);
  const formTitles = [
    'Registration Form', 'Contact Form', 'Application Form', 'Sign Up Form',
    'Customer Information', 'Profile Form', 'Event Registration', 'Inquiry Form',
    'Account Setup', 'Information Request'
  ];

  const form = {
    title: pickRandom(formTitles, rng),
    fields: [],
    layout: 'single',
    selectVariant: rng.chance(0.5) ? 'native' : 'web',
  };

  const availableCategories = ['personal', 'contact', 'professional', 'preferences', 'freeform'];
  const categoriesToUse = complexity === 'simple'
    ? ['personal', 'contact']
    : complexity === 'medium'
      ? ['personal', 'contact', 'professional']
      : availableCategories;

  const generatedData = { _rng: rng };
  ensurePersonIdentity(generatedData);

  let fieldsAdded = 0;
  const usedFields = new Set();
  const shouldForceTextarea = complexity === 'complex'
    || sourceType === 'chat'
    || sourceType === 'note'
    || (complexity === 'medium' && rng.chance(0.65));

  const addField = (category, fieldName) => {
    if (fieldsAdded >= numFields || usedFields.has(fieldName)) {
      return false;
    }

    const fieldDef = FIELD_CATEGORIES[category][fieldName];
    if (!fieldDef) {
      return false;
    }

    usedFields.add(fieldName);

    const fieldId = `input-${fieldName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const presentation = chooseFieldPresentation(fieldDef.type, rng);
    const field = {
      ...presentation,
      id: fieldId,
      label: fieldName,
      type: fieldDef.type,
      category,
      sectionTitle: CATEGORY_LABELS[category],
      required: rng.chance(0.7),
    };

    if (fieldDef.options) {
      field.options = fieldDef.options;
    }

    if (fieldName === 'City' || fieldName === 'State' || fieldName === 'ZIP Code') {
      if (!generatedData._locationData) {
        generatedData._locationData = pickRandom(CITIES, rng);
      }
    }

    form.fields.push(field);
    generatedData[fieldId] = fieldDef.generator(generatedData, rng);
    fieldsAdded += 1;
    return true;
  };

  if (shouldForceTextarea) {
    addField('freeform', pickRandom(['Comments', 'Message'], rng));
  }

  while (fieldsAdded < numFields) {
    const category = pickRandom(categoriesToUse, rng);
    const categoryFields = FIELD_CATEGORIES[category];
    const fieldNames = Object.keys(categoryFields).filter((fieldName) => !usedFields.has(fieldName));

    if (fieldNames.length === 0) {
      continue;
    }

    const fieldName = pickRandom(fieldNames, rng);
    addField(category, fieldName);
  }

  form.fields.sort((left, right) => {
    const categoryDelta = CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category);
    if (categoryDelta !== 0) {
      return categoryDelta;
    }
    return left.label.localeCompare(right.label);
  });

  for (const field of form.fields) {
    if (field.required) {
      ensureRequiredFieldValue(field, generatedData, rng);
    }
  }

  form.hasSubmit = true;
  form.submitButtonText = 'Submit';
  delete generatedData._rng;

  return { form, generatedData };
}

module.exports = {
  CATEGORY_LABELS,
  FIELD_CATEGORIES,
  createRng,
  generateForm,
  generateFormForSource,
  generateShell,
  generateSourceDocument,
};
