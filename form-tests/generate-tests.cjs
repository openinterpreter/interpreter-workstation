#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  createRng,
  generateFormForSource,
  generateSourceDocument,
} = require('./procedural-generator.cjs');
const {
  generateInfoSurface,
  generateFormSurface,
} = require('./ui-surfaces.cjs');
const { buildReceiptImageDataUrl } = require('./receipt-image-generator.cjs');

const DEFAULT_SEED = 'form-tests-v2';
const DEFAULT_TEST_COUNT = 11;
const DEFAULT_OUTPUT_DIR = path.join(__dirname, 'generated');
const TEST_MATRIX = [
  { complexity: 'simple', sourceType: 'email', infoAvailability: 'complete', noiseLevel: 'low' },
  { complexity: 'simple', sourceType: 'email', infoAvailability: 'partial', noiseLevel: 'high' },
  { complexity: 'medium', sourceType: 'article', infoAvailability: 'complete', noiseLevel: 'medium' },
  { complexity: 'medium', sourceType: 'note', infoAvailability: 'minimal', noiseLevel: 'low' },
  { complexity: 'complex', sourceType: 'chat', infoAvailability: 'excessive', noiseLevel: 'high' },
  { complexity: 'complex', sourceType: 'crm', infoAvailability: 'complete', noiseLevel: 'medium' },
  { complexity: 'medium', sourceType: 'email', infoAvailability: 'partial', noiseLevel: 'high' },
  { complexity: 'simple', sourceType: 'article', infoAvailability: 'minimal', noiseLevel: 'low' },
  { complexity: 'complex', sourceType: 'note', infoAvailability: 'excessive', noiseLevel: 'medium' },
  { complexity: 'medium', sourceType: 'chat', infoAvailability: 'complete', noiseLevel: 'high' },
  { complexity: 'medium', sourceType: 'receipt', infoAvailability: 'complete', noiseLevel: 'medium' },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    count: DEFAULT_TEST_COUNT,
    outputDir: DEFAULT_OUTPUT_DIR,
    clear: true,
    matrix: true,
    complexity: null,
    sourceType: null,
    seed: DEFAULT_SEED,
    selectedIds: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--count' && args[i + 1]) {
      options.count = Number(args[++i]);
    } else if (arg === '--output' && args[i + 1]) {
      options.outputDir = path.resolve(args[++i]);
    } else if (arg === '--no-clear') {
      options.clear = false;
    } else if (arg === '--no-matrix') {
      options.matrix = false;
    } else if (arg === '--complexity' && args[i + 1]) {
      options.complexity = args[++i];
    } else if (arg === '--source' && args[i + 1]) {
      options.sourceType = args[++i];
    } else if (arg === '--seed' && args[i + 1]) {
      options.seed = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node form-tests/generate-tests.cjs [options]

Options:
  --count <n>          Number of tests to generate (default: 11)
  --output <dir>       Output directory (default: form-tests/generated)
  --no-clear           Keep existing generated tests
  --no-matrix          Use fully random generation instead of the baseline matrix
  --complexity <type>  Restrict to simple | medium | complex
  --source <type>      Restrict to email | article | note | chat | crm | receipt
  --seed <value>       Deterministic seed (default: ${DEFAULT_SEED})
  --help, -h           Show this help message
`);
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function clearGenerated(outputDir) {
  if (!fs.existsSync(outputDir)) {
    return;
  }

  for (const entry of fs.readdirSync(outputDir)) {
    fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
  }
}

function randomChoice(values, rng) {
  return rng.pick(values);
}

function createSpec(index, options, rng) {
  const finalSourceType = options.sourceType || (options.matrix
    ? TEST_MATRIX[index % TEST_MATRIX.length].sourceType
    : randomChoice(['email', 'article', 'note', 'chat', 'crm', 'receipt'], rng));

  if (options.matrix) {
    const base = TEST_MATRIX[index % TEST_MATRIX.length];
    if (finalSourceType === 'receipt') {
      return {
        ...base,
        complexity: options.complexity || base.complexity,
        sourceType: 'receipt',
        infoAvailability: 'complete',
      };
    }
    return {
      ...base,
      complexity: options.complexity || base.complexity,
      sourceType: finalSourceType,
    };
  }

  if (finalSourceType === 'receipt') {
    return {
      complexity: options.complexity || randomChoice(['simple', 'medium', 'complex'], rng),
      sourceType: 'receipt',
      infoAvailability: 'complete',
      noiseLevel: randomChoice(['low', 'medium', 'high'], rng),
    };
  }

  return {
    complexity: options.complexity || randomChoice(['simple', 'medium', 'complex'], rng),
    sourceType: finalSourceType,
    infoAvailability: randomChoice(['complete', 'partial', 'minimal', 'excessive'], rng),
    noiseLevel: randomChoice(['low', 'medium', 'high'], rng),
  };
}

function buildDefaultLayout(complexity, rng) {
  const gap = rng.int(8, 18);
  const left = rng.int(8, 18);
  const top = rng.int(10, 28);
  const usableWidth = 1504 - left;
  const baseHeight = complexity === 'simple' ? 892 : 914;
  const infoWidth = rng.int(620, 790);
  const formWidth = usableWidth - gap - infoWidth;
  const infoHeight = Math.max(760, baseHeight + rng.int(-80, 28));
  const formHeight = Math.max(760, baseHeight + rng.int(-96, 36));

  return {
    info: {
      x: left,
      y: top,
      width: infoWidth,
      height: infoHeight,
    },
    form: {
      x: left + infoWidth + gap,
      y: top,
      width: formWidth,
      height: formHeight,
    },
  };
}

function getSourceTitle(sourceType) {
  return {
    email: 'Email Message',
    article: 'Article',
    note: 'Note',
    chat: 'Chat Conversation',
    crm: 'CRM Record',
    receipt: 'Receipt Review',
  }[sourceType] || 'Information';
}

function generatePrompt(config) {
  if (config.info.sourceType === 'receipt') {
    return 'Please complete the expense form using the information visible in the uploaded receipt image.';
  }
  const sourceLabel = (config.info.title || 'source window').toLowerCase();
  const formLabel = (config.form.title || 'destination form').toLowerCase();
  return `Please complete the ${formLabel} using the information visible in the ${sourceLabel}.`;
}

function buildDirtyTextValue(expectedValue, rng) {
  const value = String(expectedValue || '').trim();
  if (!value) {
    return '';
  }
  if (value.length <= 4) {
    return `${value}${rng.int(1, 9)}`;
  }

  const variants = [
    `${value.slice(0, Math.max(1, Math.floor(value.length * 0.45)))}`,
    `${value} ${rng.pick(['old', 'draft', 'temp'])}`,
    `${rng.pick(['Old', 'Previous', 'Legacy'])} ${value}`,
  ];
  return rng.pick(variants);
}

function stableModulo(value, modulo) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % modulo;
}

function buildDirtySelectValue(field, expectedValue, rng) {
  const options = Array.isArray(field.options) ? field.options.filter((option) => option !== expectedValue) : [];
  if (options.length === 0) {
    return expectedValue;
  }
  return rng.pick(options);
}

function buildInitialValues(fields, expectedValues, rng) {
  const seededValues = {};
  const eligibleFields = fields.filter((field) => expectedValues[field.id] !== undefined && expectedValues[field.id] !== '');
  if (eligibleFields.length === 0) {
    return seededValues;
  }

  if (stableModulo(rng.seed, 10) < 7) {
    return seededValues;
  }

  for (const field of eligibleFields) {
    if (!rng.chance(0.6)) {
      continue;
    }

    const expectedValue = expectedValues[field.id];
    seededValues[field.id] = rng.chance(0.32)
      ? expectedValue
      : field.type === 'select'
        ? buildDirtySelectValue(field, expectedValue, rng)
        : buildDirtyTextValue(expectedValue, rng);
  }

  if (Object.keys(seededValues).length === 0) {
    const fallbackField = rng.pick(eligibleFields);
    const expectedValue = expectedValues[fallbackField.id];
    seededValues[fallbackField.id] = fallbackField.type === 'select'
      ? buildDirtySelectValue(fallbackField, expectedValue, rng)
      : buildDirtyTextValue(expectedValue, rng);
  }

  return seededValues;
}

function buildConfig(spec, seed) {
  const rng = createRng(seed);
  const formData = generateFormForSource(spec.complexity, spec.sourceType, rng.fork('form'));
  const sourceDoc = generateSourceDocument(
    spec.sourceType,
    formData,
    spec.infoAvailability,
    spec.noiseLevel,
    rng.fork('source'),
  );
  const layout = buildDefaultLayout(spec.complexity, rng.fork('window-layout'));
  const totalFields = formData.form.fields.length;
  const fieldsWithData = Object.keys(sourceDoc.expectedValues).length;
  const useTwoColumnLayout = totalFields >= 3;
  const infoSurface = generateInfoSurface(spec.sourceType, spec, rng.fork('info-surface'));
  const formSurface = generateFormSurface(spec.sourceType, spec, formData.form, rng.fork('form-surface'));
  const initialValues = buildInitialValues(formData.form.fields, sourceDoc.expectedValues, rng.fork('initial-values'));

  return {
    name: `${capitalize(spec.complexity)} ${capitalize(spec.sourceType)} Form - ${capitalize(spec.infoAvailability)} Info`,
    enabled: true,
    info: {
      title: getSourceTitle(spec.sourceType),
      sourceType: spec.sourceType,
      ...layout.info,
      surface: infoSurface,
      document: sourceDoc.document,
    },
    form: {
      title: formSurface.pageTitle,
      workflow: formSurface.workspaceLabel,
      ...layout.form,
      twoColumn: useTwoColumnLayout,
      selectVariant: formData.form.selectVariant,
      surface: formSurface,
      fields: formData.form.fields,
      initialValues,
      hasSubmit: true,
      submitButtonText: formSurface.primaryAction,
      successMessage: `${formSurface.primaryAction} completed successfully.`,
    },
    task: {
      instruction: generatePrompt({
        info: { title: getSourceTitle(spec.sourceType), sourceType: spec.sourceType },
        form: { title: formSurface.pageTitle },
      }),
      gradingMode: 'visible-intersection',
      expectedValues: sourceDoc.expectedValues,
    },
    metadata: {
      seed,
      complexity: spec.complexity,
      sourceType: spec.sourceType,
      infoAvailability: spec.infoAvailability,
      noiseLevel: spec.noiseLevel,
      totalFields,
      fieldsWithData,
      initialValueCount: Object.keys(initialValues).length,
      multilineFieldCount: formData.form.fields.filter((field) => field.type === 'textarea').length,
      formThemeMode: formSurface.themeMode,
      formAccent: formSurface.accent,
      layoutValid: true,
      requiresVision: spec.sourceType === 'receipt',
    },
  };
}

function createChromeCheckoutAxTrapRegressionConfig() {
  return {
    name: 'Chrome Checkout AX Trap Regression',
    enabled: true,
    info: {
      title: 'Checkout Details',
      sourceType: 'note',
      x: 8,
      y: 12,
      width: 764,
      height: 882,
      surface: {
        family: 'note',
        productName: 'Order Notes',
        workspaceLabel: 'Shipping handoff',
        accent: 'stone',
        sidebarTitle: 'Notes',
        sidebarItems: ['Checkout', 'Address', 'Delivery'],
        filters: ['Pinned'],
        headerActions: ['Copy', 'Share'],
        secondaryMeta: ['Manual handoff'],
        activeSidebarItem: 'Checkout',
        activeFilter: 'Pinned',
      },
      document: {
        title: 'Shipping details for checkout',
        subtitle: 'Paste-only source for browser-form regression coverage',
        summaryLines: [
          'Location: United States',
          'First Name: Avery',
          'Last Name: Mercer',
          'Phone Number: (206) 555-0123',
          'Address Finder: 2401 Peabody St., Bellingham, Washington 98225',
          'Street Address: 2401 Peabody St.',
          'Apt, suite, unit, etc: Unit 1',
          'State / Province: WASHINGTON',
          'City: Bellingham',
          'Post / Zip Code: 98225',
        ],
      },
    },
    form: {
      title: 'Shipping address',
      workflow: 'Checkout',
      x: 788,
      y: 12,
      width: 716,
      height: 900,
      twoColumn: true,
      selectVariant: 'web',
      surface: {
        family: 'checkout-shipping-ax-trap',
        productName: 'SHEIN',
        workspaceLabel: 'Secure checkout',
        accent: 'stone',
        themeMode: 'light',
        pageTitle: 'Shipping Address',
        status: 'Delivery details',
        primaryAction: 'SAVE',
        meta: [
          { label: 'Step', value: 'Shipping' },
          { label: 'Mode', value: 'Browser regression' },
        ],
      },
      fields: [
        {
          id: 'input-country',
          label: 'Location',
          type: 'select',
          sectionTitle: 'Shipping information',
          required: true,
          size: 'large',
          fullWidth: true,
          controlVariant: 'shein-shell-field',
          placeholder: 'Please choose your location',
          commitMode: 'option-only',
          axHiddenLabel: '',
          menuSections: [
            { title: 'A', options: ['Australia', 'Austria'] },
            { title: 'C', options: ['Canada'] },
            { title: 'M', options: ['Mexico'] },
            { title: 'U', options: ['United Kingdom', 'United States'] },
          ],
        },
        {
          id: 'input-first-name',
          label: 'First Name',
          type: 'text',
          sectionTitle: 'Shipping information',
          required: true,
          size: 'large',
          controlVariant: 'shein-shell-field',
          placeholder: '',
          commitMode: 'free-text',
          validationMessage: 'First Name should be 2-34 letters or spaces',
          axDescribeWithValidation: true,
          axShellLabel: 'First Name should be 2-34 letters or spaces',
          axDisplayLabel: 'First Name should be 2-34 letters or spaces',
          axLiveLabel: 'First Name should be 2-34 letters or spaces',
          axHiddenLabel: '',
        },
        {
          id: 'input-last-name',
          label: 'Last Name',
          type: 'text',
          sectionTitle: 'Shipping information',
          required: true,
          size: 'large',
          controlVariant: 'shein-shell-field',
          placeholder: '',
          commitMode: 'free-text',
          validationMessage: 'Last Name should be 2-34 letters or spaces',
          axDescribeWithValidation: true,
          axShellLabel: 'Last Name should be 2-34 letters or spaces',
          axDisplayLabel: 'Last Name should be 2-34 letters or spaces',
          axLiveLabel: 'Last Name should be 2-34 letters or spaces',
          axHiddenLabel: '',
        },
        {
          id: 'input-phone-number',
          label: 'Phone Number',
          type: 'tel',
          sectionTitle: 'Shipping information',
          required: true,
          size: 'large',
          fullWidth: true,
          controlVariant: 'shein-shell-field',
          caption: '',
          placeholder: '',
          prefixText: 'US +1',
          commitMode: 'free-text',
          validationMessage: 'Phone number should be a 10-digit number',
          axShellLabel: 'input',
          axDisplayLabel: 'input',
          axLiveLabel: 'input',
          axHiddenLabel: '',
        },
        {
          id: 'input-associated-address',
          label: 'Address Finder',
          type: 'text',
          sectionTitle: 'Shipping information',
          required: false,
          size: 'large',
          fullWidth: true,
          controlVariant: 'shein-address-finder',
          caption: 'Start typing your address to find your full address, then select from the list.',
          placeholder: 'ADDRESS FINDER: Search by postcode, street or address',
          axHiddenLabel: '',
          axDisplayLabel: 'Address Finder',
          axLiveLabel: 'Address Finder',
          autocompleteOptions: [
            {
              label: '2401 Peabody St., Bellingham, Washington 98225',
              fills: {
                'input-address1': '2401 Peabody St.',
                'input-state': 'WASHINGTON',
                'input-city': 'Bellingham',
                'input-postcode': '98225',
              },
            },
            {
              label: '2401 Peabody Street, Bellingham, Washington 98225',
              fills: {
                'input-address1': '2401 Peabody St.',
                'input-state': 'WASHINGTON',
                'input-city': 'Bellingham',
                'input-postcode': '98225',
              },
            },
            {
              label: '2401 Peabody St Apt A, Bellingham, Washington 98225',
              fills: {
                'input-address1': '2401 Peabody St.',
                'input-address2': 'Apt A',
                'input-state': 'WASHINGTON',
                'input-city': 'Bellingham',
                'input-postcode': '98225',
              },
            },
            {
              label: '2401 Peabody St Unit 2, Bellingham, Washington 98225',
              fills: {
                'input-address1': '2401 Peabody St.',
                'input-address2': 'Unit 2',
                'input-state': 'WASHINGTON',
                'input-city': 'Bellingham',
                'input-postcode': '98225',
              },
            },
            {
              label: '2403 Peabody St., Bellingham, Washington 98225',
              fills: {
                'input-address1': '2403 Peabody St.',
                'input-state': 'WASHINGTON',
                'input-city': 'Bellingham',
                'input-postcode': '98225',
              },
            },
            {
              label: '2401 Peabody St #1, Bellingham, Washington 98225',
              fills: {
                'input-address1': '2401 Peabody St.',
                'input-address2': '#1',
                'input-state': 'WASHINGTON',
                'input-city': 'Bellingham',
                'input-postcode': '98225',
              },
            },
            {
              label: '2401 Peabody St Unit 1, Bellingham, Washington 98225',
              fills: {
                'input-address1': '2401 Peabody St.',
                'input-address2': 'Unit 1',
                'input-state': 'WASHINGTON',
                'input-city': 'Bellingham',
                'input-postcode': '98225',
              },
            },
            {
              label: '2401 Peabody Street Unit 1, Bellingham, Washington 98225',
              fills: {
                'input-address1': '2401 Peabody St.',
                'input-address2': 'Unit 1',
                'input-state': 'WASHINGTON',
                'input-city': 'Bellingham',
                'input-postcode': '98225',
              },
            },
            {
              label: '2401 Peabody St, Bellingham, WA 98225',
              fills: {
                'input-address1': '2401 Peabody St.',
                'input-state': 'WASHINGTON',
                'input-city': 'Bellingham',
                'input-postcode': '98225',
              },
            },
            {
              label: '2401 Peabody Ln., Bellingham, Washington 98226',
              fills: {
                'input-address1': '2401 Peabody Ln.',
                'input-state': 'WASHINGTON',
                'input-city': 'Bellingham',
                'input-postcode': '98226',
              },
            },
            {
              label: '2410 Peabody St., Bellingham, Washington 98225',
              fills: {
                'input-address1': '2410 Peabody St.',
                'input-state': 'WASHINGTON',
                'input-city': 'Bellingham',
                'input-postcode': '98225',
              },
            },
            {
              label: '2401 Peabody St., Seattle, Washington 98109',
              fills: {
                'input-address1': '2401 Peabody St.',
                'input-state': 'WASHINGTON',
                'input-city': 'Seattle',
                'input-postcode': '98109',
              },
            },
            {
              label: '2401 Peaceful Valley Rd., Bellingham, Washington 98225',
              fills: {
                'input-address1': '2401 Peaceful Valley Rd.',
                'input-state': 'WASHINGTON',
                'input-city': 'Bellingham',
                'input-postcode': '98225',
              },
            },
          ],
        },
        {
          id: 'input-address1',
          label: 'Street address',
          type: 'textarea',
          sectionTitle: 'Shipping information',
          required: true,
          size: 'large',
          fullWidth: true,
          placeholder: 'Street name and street number, company name.',
          rows: 2,
          maxLength: 30,
          validationMessage: 'Address Line 1 should contain 5-30 letters, digits or spaces and cannot contain @.',
        },
        {
          id: 'input-address2',
          label: 'Apt, suite,unit,etc(optional)',
          type: 'text',
          sectionTitle: 'Shipping information',
          required: false,
          size: 'large',
          fullWidth: true,
          controlVariant: 'shein-shell-field',
          placeholder: 'Building/Apartment/Suite no, Unit, Floor, etc (optional)',
          liveTag: 'textarea',
          compactShell: true,
          rows: 2,
          commitMode: 'free-text',
          maxLengthText: '0 / 30',
        },
        {
          id: 'input-state',
          label: 'State/Province',
          type: 'select',
          sectionTitle: 'Shipping information',
          required: true,
          size: 'large',
          controlVariant: 'shein-shell-field',
          placeholder: 'Please Choose Your State/Province',
          commitMode: 'option-only',
          axHiddenLabel: '',
          menuSections: [
            { title: 'A', options: ['AA', 'AE', 'ALABAMA', 'ALASKA', 'AP', 'ARIZONA', 'ARKANSAS'] },
            { title: 'C', options: ['CALIFORNIA', 'COLORADO', 'CONNECTICUT'] },
            { title: 'D', options: ['DELAWARE', 'DISTRICT OF COLUMBIA'] },
            { title: 'F', options: ['FLORIDA'] },
            { title: 'G', options: ['GEORGIA'] },
            { title: 'H', options: ['HAWAII'] },
            { title: 'I', options: ['IDAHO', 'ILLINOIS', 'INDIANA', 'IOWA'] },
            { title: 'K', options: ['KANSAS'] },
            { title: 'W', options: ['WASHINGTON'] },
          ],
        },
        {
          id: 'input-city',
          label: 'City',
          type: 'text',
          sectionTitle: 'Shipping information',
          required: true,
          size: 'large',
          controlVariant: 'shein-shell-field',
          dependsOn: 'input-state',
          placeholder: '',
          commitMode: 'free-text',
          axHiddenLabel: '',
          optionGroups: {
            WASHINGTON: ['Bellingham', 'Seattle', 'Tacoma'],
            OREGON: ['Portland', 'Bend'],
            CALIFORNIA: ['San Diego', 'Los Angeles'],
          },
        },
        {
          id: 'input-postcode',
          label: 'Post/Zip Code',
          type: 'text',
          sectionTitle: 'Shipping information',
          required: true,
          size: 'large',
          fullWidth: true,
          controlVariant: 'shein-shell-field',
          dependsOn: 'input-city',
          placeholder: '',
          commitMode: 'free-text',
          axHiddenLabel: '',
          optionGroups: {
            Bellingham: ['98225'],
            Seattle: ['98101'],
            Tacoma: ['98402'],
            Portland: ['97201'],
            Bend: ['97701'],
            'San Diego': ['92101'],
            'Los Angeles': ['90001'],
          },
        },
      ],
      initialValues: {
        'input-country': 'United States',
      },
      hasSubmit: true,
      submitButtonText: 'Save shipping address',
      successMessage: 'Shipping address saved successfully.',
    },
    task: {
      instruction: 'Please complete the shipping address form using the pasted checkout details.',
      gradingMode: 'visible-intersection',
      expectedValues: {
        'input-first-name': 'Avery',
        'input-last-name': 'Mercer',
        'input-phone-number': '(206) 555-0123',
        'input-address1': '2401 Peabody St.',
        'input-address2': 'Unit 1',
        'input-state': 'WASHINGTON',
        'input-city': 'Bellingham',
        'input-postcode': '98225',
      },
    },
    metadata: {
      seed: 'regression:chrome-checkout-ax-trap',
      complexity: 'regression',
      sourceType: 'note',
      infoAvailability: 'complete',
      noiseLevel: 'low',
      totalFields: 10,
      fieldsWithData: 7,
      initialValueCount: 1,
      multilineFieldCount: 1,
      formThemeMode: 'light',
      formAccent: 'stone',
      layoutValid: true,
      requiresVision: false,
      regressionTag: 'chrome-checkout-ax-trap',
      sourceReferenceLabel: 'Real SHEIN checkout form',
      sourceReferenceUrl: 'https://us.shein.com/checkout?auto_coupon=newonly30',
    },
  };
}

function createExpenseReportJsRegressionConfig() {
  return {
    name: 'Expense Report JS Regression',
    enabled: true,
    info: {
      title: 'Expense Brief',
      sourceType: 'note',
      x: 8,
      y: 12,
      width: 748,
      height: 888,
      surface: {
        family: 'note',
        productName: 'Finance Notes',
        workspaceLabel: 'Reimbursement desk',
        accent: 'slate',
        sidebarTitle: 'Queues',
        sidebarItems: ['New requests', 'Needs receipts', 'Manager review'],
        filters: ['Travel', 'Priority'],
        headerActions: ['Pin', 'Share'],
        secondaryMeta: ['North America', 'Ops'],
        activeSidebarItem: 'New requests',
        activeFilter: 'Travel',
      },
      document: {
        title: 'Expense reimbursement draft',
        subtitle: 'Use only the information captured in this operator brief.',
        summaryLines: [
          'Report Name: Q1 customer summit travel',
          'Department: Revenue',
          'Team: Enterprise Sales',
          'Expense Category: Lodging',
          'Merchant: Hotel Zelos',
          'Expense Date: 2026-03-18',
          'Amount: 642.18',
          'Currency: USD',
          'Payment Method: Personal Card',
          'City of Spend: San Francisco',
          'Project Code: REV-SUMMIT-24',
          'Approver: Nora Patel',
          'Additional Notes: Client dinner moved to a separate receipt. Hotel folio already includes taxes and Wi-Fi.',
        ],
      },
    },
    form: {
      title: 'Expense report',
      workflow: 'Reimbursements',
      x: 772,
      y: 12,
      width: 732,
      height: 902,
      twoColumn: true,
      selectVariant: 'web',
      surface: {
        family: 'expense-report-js-lab',
        productName: 'LedgerFox',
        workspaceLabel: 'Expense approvals',
        accent: 'slate',
        themeMode: 'light',
        pageTitle: 'New expense report',
        status: 'Draft reimbursement',
        primaryAction: 'Submit report',
        meta: [
          { label: 'Step', value: 'Review' },
          { label: 'Mode', value: 'JS controls' },
        ],
      },
      fields: [
        {
          id: 'input-report-name',
          label: 'Report Name',
          type: 'text',
          sectionTitle: 'Report details',
          required: true,
          size: 'large',
          fullWidth: true,
          placeholder: 'Quarterly summit travel',
        },
        {
          id: 'input-department',
          label: 'Department',
          type: 'select',
          sectionTitle: 'Report details',
          required: true,
          size: 'large',
          controlVariant: 'checkout-transient-combobox',
          placeholder: 'Search departments',
          options: ['Finance', 'Operations', 'People', 'Revenue'],
        },
        {
          id: 'input-team',
          label: 'Team',
          type: 'select',
          sectionTitle: 'Report details',
          required: true,
          size: 'large',
          controlVariant: 'checkout-transient-combobox',
          dependsOn: 'input-department',
          placeholder: 'Pick a team',
          optionGroups: {
            Finance: ['Accounts Payable', 'FP&A'],
            Operations: ['Customer Ops', 'Field Ops'],
            People: ['Talent', 'People Operations'],
            Revenue: ['Enterprise Sales', 'Mid-Market Sales', 'Solutions Engineering'],
          },
        },
        {
          id: 'input-expense-category',
          label: 'Expense Category',
          type: 'select',
          sectionTitle: 'Expense details',
          required: true,
          size: 'large',
          controlVariant: 'checkout-transient-combobox',
          placeholder: 'Search categories',
          options: ['Airfare', 'Client Entertainment', 'Ground Transport', 'Lodging', 'Meals', 'Software'],
        },
        {
          id: 'input-merchant',
          label: 'Merchant',
          type: 'text',
          sectionTitle: 'Expense details',
          required: true,
          size: 'large',
          placeholder: 'Merchant name',
        },
        {
          id: 'input-expense-date',
          label: 'Expense Date',
          type: 'text',
          sectionTitle: 'Expense details',
          required: true,
          size: 'large',
          placeholder: 'YYYY-MM-DD',
        },
        {
          id: 'input-amount',
          label: 'Amount',
          type: 'text',
          sectionTitle: 'Expense details',
          required: true,
          size: 'large',
          placeholder: '0.00',
        },
        {
          id: 'input-currency',
          label: 'Currency',
          type: 'select',
          sectionTitle: 'Expense details',
          required: true,
          size: 'large',
          controlVariant: 'checkout-transient-combobox',
          placeholder: 'Currency',
          options: ['AUD', 'CAD', 'EUR', 'GBP', 'USD'],
        },
        {
          id: 'input-payment-method',
          label: 'Payment Method',
          type: 'select',
          sectionTitle: 'Expense details',
          required: true,
          size: 'large',
          controlVariant: 'checkout-transient-combobox',
          placeholder: 'Select payment method',
          options: ['Cash', 'Corporate Card', 'Personal Card'],
        },
        {
          id: 'input-city',
          label: 'City of Spend',
          type: 'text',
          sectionTitle: 'Policy routing',
          required: true,
          size: 'large',
          placeholder: 'City',
        },
        {
          id: 'input-project-code',
          label: 'Project Code',
          type: 'select',
          sectionTitle: 'Policy routing',
          required: true,
          size: 'large',
          controlVariant: 'checkout-transient-combobox',
          dependsOn: 'input-team',
          placeholder: 'Search project codes',
          optionGroups: {
            'Accounts Payable': ['FIN-CLOSE-11', 'FIN-VENDOR-03'],
            'Customer Ops': ['OPS-CARE-12', 'OPS-QBR-09'],
            'Enterprise Sales': ['REV-SUMMIT-24', 'REV-ONSITE-07'],
            'Field Ops': ['OPS-SITE-31', 'OPS-LAUNCH-18'],
            'FP&A': ['FIN-PLAN-22', 'FIN-FORECAST-08'],
            'Mid-Market Sales': ['REV-MIDMARKET-14', 'REV-PIPELINE-05'],
            'People Operations': ['PEOPLE-OFFSITE-02', 'PEOPLE-HIRING-11'],
            'Solutions Engineering': ['REV-SE-DEMO-10', 'REV-LAB-21'],
            Talent: ['PEOPLE-RECRUIT-03', 'PEOPLE-ONBOARD-06'],
          },
        },
        {
          id: 'input-approver',
          label: 'Approver',
          type: 'select',
          sectionTitle: 'Policy routing',
          required: true,
          size: 'large',
          controlVariant: 'checkout-transient-combobox',
          dependsOn: 'input-department',
          placeholder: 'Manager approver',
          optionGroups: {
            Finance: ['Brianna Moss', 'Luca Tran'],
            Operations: ['Arjun Singh', 'Leah Kim'],
            People: ['Monica Wells', 'Priya Shah'],
            Revenue: ['Nora Patel', 'Victor Alvarez'],
          },
        },
        {
          id: 'input-notes',
          label: 'Additional Notes',
          type: 'textarea',
          sectionTitle: 'Supporting context',
          required: true,
          size: 'large',
          fullWidth: true,
          rows: 4,
          placeholder: 'Add supporting context for reviewers',
        },
      ],
      initialValues: {
        'input-currency': 'USD',
      },
      hasSubmit: true,
      submitButtonText: 'Submit expense report',
      successMessage: 'Expense report submitted successfully.',
    },
    task: {
      instruction: 'Please complete the expense report using the reimbursement brief.',
      gradingMode: 'visible-intersection',
      expectedValues: {
        'input-report-name': 'Q1 customer summit travel',
        'input-department': 'Revenue',
        'input-team': 'Enterprise Sales',
        'input-expense-category': 'Lodging',
        'input-merchant': 'Hotel Zelos',
        'input-expense-date': '2026-03-18',
        'input-amount': '642.18',
        'input-currency': 'USD',
        'input-payment-method': 'Personal Card',
        'input-city': 'San Francisco',
        'input-project-code': 'REV-SUMMIT-24',
        'input-approver': 'Nora Patel',
        'input-notes': 'Client dinner moved to a separate receipt. Hotel folio already includes taxes and Wi-Fi.',
      },
    },
    metadata: {
      seed: 'regression:expense-report-js',
      complexity: 'regression',
      sourceType: 'note',
      infoAvailability: 'complete',
      noiseLevel: 'medium',
      totalFields: 13,
      fieldsWithData: 13,
      initialValueCount: 1,
      multilineFieldCount: 1,
      formThemeMode: 'light',
      formAccent: 'slate',
      layoutValid: true,
      requiresVision: false,
      regressionTag: 'expense-report-js',
      sourceReferenceLabel: 'Real JS-heavy reimbursement flow pattern',
      sourceReferenceUrl: 'https://www.expensify.com/resources/how-to-submit-expense-reports',
    },
  };
}

function createDropdownHeavyVendorIntakeConfig() {
  return {
    name: 'Dropdown Heavy Vendor Intake',
    enabled: true,
    info: {
      title: 'Vendor Intake Brief',
      sourceType: 'note',
      x: 8,
      y: 12,
      width: 736,
      height: 900,
      surface: {
        family: 'note',
        productName: 'Ops Notes',
        workspaceLabel: 'Vendor operations',
        accent: 'emerald',
        sidebarTitle: 'Queues',
        sidebarItems: ['Intake', 'Approvals', 'Provisioned'],
        filters: ['Priority', 'North America'],
        headerActions: ['Pin', 'Share'],
        secondaryMeta: ['Vendors', 'Ready'],
        activeSidebarItem: 'Intake',
        activeFilter: 'Priority',
      },
      document: {
        title: 'Provisioning brief',
        subtitle: 'Populate the intake form using only this intake brief.',
        summaryLines: [
          'Vendor Name: Northstar Analytics',
          'Admin Email: ops@northstar-analytics.com',
          'Department: Revenue Operations',
          'Role Level: Manager',
          'Region: North America',
          'Country: United States',
          'Time Zone: Pacific Time',
          'Preferred Language: English',
          'Support Tier: Enterprise',
          'Billing Cycle: Quarterly',
          'Notification Channel: Slack',
          'Implementation Phase: Pilot',
          'Contract Type: Services',
          'Data Residency: United States',
          'Access Model: SSO Required',
          'Security Review Status: Approved',
          'Launch Notes: Pilot workspace is for west coast onboarding only. Route alerts to the shared revops Slack channel.',
        ],
      },
    },
    form: {
      title: 'Vendor intake',
      workflow: 'Provisioning',
      x: 768,
      y: 12,
      width: 736,
      height: 920,
      twoColumn: true,
      selectVariant: 'native',
      surface: {
        family: 'vendor-intake',
        productName: 'Partner Console',
        workspaceLabel: 'Provisioning',
        accent: 'emerald',
        themeMode: 'light',
        pageTitle: 'Vendor intake',
        status: 'Ready for setup',
        primaryAction: 'Create vendor',
        meta: [
          { label: 'Owner', value: 'Jamie Chen' },
          { label: 'Queue', value: 'Priority' },
        ],
        activeNavItem: 'Vendors',
        activeTab: 'Intake',
        showAside: true,
      },
      fields: [
        {
          id: 'input-vendor-name',
          label: 'Vendor Name',
          type: 'text',
          sectionTitle: 'Company details',
          required: true,
          size: 'large',
          fullWidth: true,
        },
        {
          id: 'input-admin-email',
          label: 'Admin Email',
          type: 'email',
          sectionTitle: 'Company details',
          required: true,
          size: 'large',
          fullWidth: true,
        },
        {
          id: 'input-department',
          label: 'Department',
          type: 'select',
          sectionTitle: 'Routing',
          required: true,
          size: 'large',
          options: ['Customer Success', 'Finance', 'People Operations', 'Revenue Operations', 'Security'],
        },
        {
          id: 'input-role-level',
          label: 'Role Level',
          type: 'select',
          sectionTitle: 'Routing',
          required: true,
          size: 'large',
          options: ['Analyst', 'Coordinator', 'Director', 'Manager', 'Specialist'],
        },
        {
          id: 'input-region',
          label: 'Region',
          type: 'select',
          sectionTitle: 'Routing',
          required: true,
          size: 'large',
          options: ['APAC', 'EMEA', 'Latin America', 'North America'],
        },
        {
          id: 'input-country',
          label: 'Country',
          type: 'select',
          sectionTitle: 'Routing',
          required: true,
          size: 'large',
          options: ['Australia', 'Canada', 'Germany', 'Japan', 'United States'],
        },
        {
          id: 'input-time-zone',
          label: 'Time Zone',
          type: 'select',
          sectionTitle: 'Routing',
          required: true,
          size: 'large',
          options: ['Central European Time', 'Eastern Time', 'Japan Standard Time', 'Pacific Time', 'UTC'],
        },
        {
          id: 'input-preferred-language',
          label: 'Preferred Language',
          type: 'select',
          sectionTitle: 'Preferences',
          required: true,
          size: 'large',
          options: ['English', 'French', 'German', 'Japanese', 'Spanish'],
        },
        {
          id: 'input-support-tier',
          label: 'Support Tier',
          type: 'select',
          sectionTitle: 'Preferences',
          required: true,
          size: 'large',
          options: ['Community', 'Enterprise', 'Premium', 'Standard'],
        },
        {
          id: 'input-billing-cycle',
          label: 'Billing Cycle',
          type: 'select',
          sectionTitle: 'Preferences',
          required: true,
          size: 'large',
          options: ['Annual', 'Monthly', 'Quarterly', 'Semiannual'],
        },
        {
          id: 'input-notification-channel',
          label: 'Notification Channel',
          type: 'select',
          sectionTitle: 'Preferences',
          required: true,
          size: 'large',
          options: ['Email', 'In-app', 'Phone', 'Slack', 'SMS'],
        },
        {
          id: 'input-implementation-phase',
          label: 'Implementation Phase',
          type: 'select',
          sectionTitle: 'Provisioning controls',
          required: true,
          size: 'large',
          options: ['Discovery', 'Enablement', 'Go Live', 'Pilot', 'Rollout'],
        },
        {
          id: 'input-contract-type',
          label: 'Contract Type',
          type: 'select',
          sectionTitle: 'Provisioning controls',
          required: true,
          size: 'large',
          options: ['Consulting', 'Partner', 'Reseller', 'Services', 'Technology'],
        },
        {
          id: 'input-data-residency',
          label: 'Data Residency',
          type: 'select',
          sectionTitle: 'Provisioning controls',
          required: true,
          size: 'large',
          options: ['Canada', 'European Union', 'Global', 'Japan', 'United States'],
        },
        {
          id: 'input-access-model',
          label: 'Access Model',
          type: 'select',
          sectionTitle: 'Provisioning controls',
          required: true,
          size: 'large',
          options: ['Email Invite', 'Manual Accounts', 'SCIM Provisioning', 'SSO Required'],
        },
        {
          id: 'input-security-review-status',
          label: 'Security Review Status',
          type: 'select',
          sectionTitle: 'Provisioning controls',
          required: true,
          size: 'large',
          options: ['Approved', 'Blocked', 'In Review', 'Pending'],
        },
        {
          id: 'input-launch-notes',
          label: 'Launch Notes',
          type: 'textarea',
          sectionTitle: 'Notes',
          required: true,
          size: 'large',
          fullWidth: true,
          rows: 4,
        },
      ],
      initialValues: {},
      hasSubmit: true,
      submitButtonText: 'Create vendor',
      successMessage: 'Vendor intake submitted successfully.',
    },
    task: {
      instruction: 'Please complete the vendor intake form using the provisioning brief.',
      gradingMode: 'visible-intersection',
      expectedValues: {
        'input-vendor-name': 'Northstar Analytics',
        'input-admin-email': 'ops@northstar-analytics.com',
        'input-department': 'Revenue Operations',
        'input-role-level': 'Manager',
        'input-region': 'North America',
        'input-country': 'United States',
        'input-time-zone': 'Pacific Time',
        'input-preferred-language': 'English',
        'input-support-tier': 'Enterprise',
        'input-billing-cycle': 'Quarterly',
        'input-notification-channel': 'Slack',
        'input-implementation-phase': 'Pilot',
        'input-contract-type': 'Services',
        'input-data-residency': 'United States',
        'input-access-model': 'SSO Required',
        'input-security-review-status': 'Approved',
        'input-launch-notes': 'Pilot workspace is for west coast onboarding only. Route alerts to the shared revops Slack channel.',
      },
    },
    metadata: {
      seed: 'regression:dropdown-heavy-vendor-intake',
      complexity: 'regression',
      sourceType: 'note',
      infoAvailability: 'complete',
      noiseLevel: 'medium',
      totalFields: 17,
      fieldsWithData: 17,
      initialValueCount: 0,
      multilineFieldCount: 1,
      formThemeMode: 'light',
      formAccent: 'emerald',
      layoutValid: true,
      requiresVision: false,
      regressionTag: 'dropdown-heavy-vendor-intake',
    },
  };
}

function createOverlayScreenshotSaveConfig() {
  return {
    name: 'Overlay Smart Screenshot Save',
    enabled: true,
    info: {
      title: 'Capture request',
      sourceType: 'note',
      x: 8,
      y: 12,
      width: 736,
      height: 900,
      surface: {
        family: 'note',
        productName: 'Ops Notes',
        workspaceLabel: 'Archive queue',
        accent: 'emerald',
        sidebarTitle: 'Queues',
        sidebarItems: ['Capture', 'Archive', 'Ready'],
        filters: ['Forms'],
        headerActions: ['Copy', 'Share'],
        secondaryMeta: ['Images', 'Requested'],
        activeSidebarItem: 'Capture',
        activeFilter: 'Forms',
      },
      document: {
        title: 'Screenshot export request',
        subtitle: 'Save the selected form screenshot into the workspace without changing the form.',
        summaryLines: [
          'Workspace folder: forms/',
          'Filename: lead-profile-northstar-crm.png',
          'Do not edit or submit the form.',
        ],
      },
    },
    form: {
      title: 'Lead profile',
      workflow: 'Northstar CRM',
      x: 768,
      y: 12,
      width: 736,
      height: 920,
      twoColumn: true,
      selectVariant: 'native',
      surface: {
        family: 'lead-profile',
        productName: 'Northstar CRM',
        workspaceLabel: 'Sales',
        accent: 'emerald',
        themeMode: 'light',
        pageTitle: 'Lead profile',
        status: 'Ready for review',
        primaryAction: 'Save lead',
        meta: [
          {
            label: 'Owner',
            value: 'Avery Patel',
          },
          {
            label: 'Stage',
            value: 'Qualified',
          },
        ],
        activeNavItem: 'Leads',
        activeTab: 'Profile',
        showAside: true,
      },
      fields: [
        {
          id: 'input-full-name',
          label: 'Full Name',
          type: 'text',
          sectionTitle: 'Lead details',
          required: true,
          size: 'large',
        },
        {
          id: 'input-company-name',
          label: 'Company',
          type: 'text',
          sectionTitle: 'Lead details',
          required: true,
          size: 'large',
        },
        {
          id: 'input-email',
          label: 'Work Email',
          type: 'email',
          sectionTitle: 'Lead details',
          required: true,
          size: 'large',
          fullWidth: true,
        },
        {
          id: 'input-region',
          label: 'Region',
          type: 'select',
          sectionTitle: 'Routing',
          required: true,
          size: 'large',
          options: ['APAC', 'EMEA', 'North America'],
        },
        {
          id: 'input-priority',
          label: 'Priority',
          type: 'select',
          sectionTitle: 'Routing',
          required: true,
          size: 'large',
          options: ['Low', 'Medium', 'High'],
        },
        {
          id: 'input-notes',
          label: 'Notes',
          type: 'textarea',
          sectionTitle: 'Notes',
          required: false,
          size: 'large',
          fullWidth: true,
          rows: 4,
        },
      ],
      initialValues: {},
      hasSubmit: true,
      submitButtonText: 'Save lead',
      successMessage: 'Lead saved successfully.',
    },
    task: {
      instruction: 'Do not fill or modify this form. Save the initial screenshot of the selected form region into forms/lead-profile-northstar-crm.png in the current workspace using that exact filename.',
      gradingMode: 'workspace-artifact',
      sourceContext: 'window',
      overlaySelectionMode: 'drag-select-form',
      overlaySubmitMode: 'workspace-agent',
      overlayProfileLabel: 'Smart',
      overlayDetachExpectation: 'detach-before-command',
      requireFormUnchanged: true,
      expectedArtifact: {
        relativePath: 'forms/lead-profile-northstar-crm.png',
        filenameKeywords: ['lead', 'profile', 'northstar', 'crm'],
        minBytes: 12000,
        matchesInitialScreenshot: true,
      },
    },
    metadata: {
      seed: 'regression:overlay-smart-screenshot-save',
      complexity: 'regression',
      sourceType: 'note',
      infoAvailability: 'complete',
      noiseLevel: 'low',
      totalFields: 6,
      fieldsWithData: 0,
      initialValueCount: 0,
      multilineFieldCount: 1,
      formThemeMode: 'light',
      formAccent: 'emerald',
      layoutValid: true,
      requiresVision: false,
      regressionTag: 'overlay-smart-screenshot-save',
    },
  };
}

function createOverlayInterpreterFastLeadFillConfig() {
  return {
    name: 'Overlay Interpreter Fast Lead Fill',
    enabled: true,
    info: {
      title: 'Lead intake briefing',
      sourceType: 'note',
      x: 8,
      y: 12,
      width: 736,
      height: 900,
      surface: {
        family: 'note',
        productName: 'Ops Notes',
        workspaceLabel: 'Sales queue',
        accent: 'emerald',
        sidebarTitle: 'Briefings',
        sidebarItems: ['Lead intake', 'Escalations', 'Archive'],
        filters: ['North America'],
        headerActions: ['Copy', 'Share'],
        secondaryMeta: ['CRM', 'Lead'],
        activeSidebarItem: 'Lead intake',
        activeFilter: 'North America',
      },
      document: {
        title: 'Lead profile briefing',
        subtitle: 'Populate the selected lead profile form using only this briefing.',
        summaryLines: [
          'Full Name: Jordan Lee',
          'Company: Northstar Analytics',
          'Work Email: jordan.lee@northstar-analytics.com',
          'Region: North America',
          'Priority: High',
          'Notes: Qualified inbound lead from the revops webinar. Follow up this week with a demo proposal.',
        ],
      },
    },
    form: {
      title: 'Lead profile',
      workflow: 'Northstar CRM',
      x: 768,
      y: 12,
      width: 736,
      height: 920,
      twoColumn: true,
      selectVariant: 'native',
      surface: {
        family: 'lead-profile',
        productName: 'Northstar CRM',
        workspaceLabel: 'Sales',
        accent: 'emerald',
        themeMode: 'light',
        pageTitle: 'Lead profile',
        status: 'Ready for review',
        primaryAction: 'Save lead',
        meta: [
          {
            label: 'Owner',
            value: 'Avery Patel',
          },
          {
            label: 'Stage',
            value: 'Qualified',
          },
        ],
        activeNavItem: 'Leads',
        activeTab: 'Profile',
        showAside: true,
      },
      fields: [
        {
          id: 'input-full-name',
          label: 'Full Name',
          type: 'text',
          sectionTitle: 'Lead details',
          required: true,
          size: 'large',
        },
        {
          id: 'input-company-name',
          label: 'Company',
          type: 'text',
          sectionTitle: 'Lead details',
          required: true,
          size: 'large',
        },
        {
          id: 'input-email',
          label: 'Work Email',
          type: 'email',
          sectionTitle: 'Lead details',
          required: true,
          size: 'large',
          fullWidth: true,
        },
        {
          id: 'input-region',
          label: 'Region',
          type: 'select',
          sectionTitle: 'Routing',
          required: true,
          size: 'large',
          options: ['APAC', 'EMEA', 'North America'],
        },
        {
          id: 'input-priority',
          label: 'Priority',
          type: 'select',
          sectionTitle: 'Routing',
          required: true,
          size: 'large',
          options: ['Low', 'Medium', 'High'],
        },
        {
          id: 'input-notes',
          label: 'Notes',
          type: 'textarea',
          sectionTitle: 'Notes',
          required: false,
          size: 'large',
          fullWidth: true,
          rows: 4,
        },
      ],
      initialValues: {},
      hasSubmit: true,
      submitButtonText: 'Save lead',
      successMessage: 'Lead saved successfully.',
    },
    task: {
      instruction: 'Please complete the lead profile form using the briefing.',
      gradingMode: 'visible-intersection',
      overlaySelectionMode: 'drag-select-form',
      overlaySubmitMode: 'workspace-agent',
      overlayProfileLabel: 'Fast',
      overlayDetachExpectation: 'live-overlay-fill',
      expectedValues: {
        'input-full-name': 'Jordan Lee',
        'input-company-name': 'Northstar Analytics',
        'input-email': 'jordan.lee@northstar-analytics.com',
        'input-region': 'North America',
        'input-priority': 'High',
        'input-notes': 'Qualified inbound lead from the revops webinar. Follow up this week with a demo proposal.',
      },
    },
    metadata: {
      seed: 'regression:overlay-interpreter-fast-lead-fill',
      complexity: 'regression',
      sourceType: 'note',
      infoAvailability: 'complete',
      noiseLevel: 'low',
      totalFields: 6,
      fieldsWithData: 6,
      initialValueCount: 0,
      multilineFieldCount: 1,
      formThemeMode: 'light',
      formAccent: 'emerald',
      layoutValid: true,
      requiresVision: false,
      regressionTag: 'overlay-interpreter-fast-lead-fill',
    },
  };
}

function summarizeDocument(document) {
  if (Array.isArray(document.summaryLines) && document.summaryLines.length > 0) {
    return [document.title, document.subtitle || '', '', ...document.summaryLines].filter(Boolean).join('\n');
  }

  const lines = [document.title];
  if (document.subtitle) {
    lines.push(document.subtitle);
  }
  for (const item of document.meta || []) {
    lines.push(`${item.label}: ${item.value}`);
  }
  for (const section of document.sections || []) {
    lines.push(``);
    lines.push(`[${section.title}]`);
    for (const entry of section.items) {
      if (entry.type === 'fact') {
        lines.push(`${entry.label}: ${entry.value}`);
      } else if (entry.type === 'message') {
        lines.push(`${entry.speaker} (${entry.time}): ${entry.text}`);
      } else {
        lines.push(entry.text);
      }
    }
  }
  return lines.join('\n');
}

async function writeTest(testIndex, config, outputDir, explicitTestId = null) {
  const testId = explicitTestId || `test-${String(testIndex + 1).padStart(3, '0')}`;
  const testDir = path.join(outputDir, testId);
  ensureDir(testDir);

  fs.writeFileSync(path.join(testDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(testDir, 'document.txt'), `${summarizeDocument(config.info.document)}\n`);
  fs.writeFileSync(
    path.join(testDir, 'analysis.txt'),
    [
      `${testId}: ${config.name}`,
      '',
      `Seed: ${config.metadata.seed}`,
      `Runner prompt: ${config.task.instruction}`,
      `Fields: ${config.metadata.totalFields}`,
      `Fields with data: ${config.metadata.fieldsWithData}`,
      `Complexity: ${config.metadata.complexity}`,
      `Source: ${config.metadata.sourceType}`,
      `Availability: ${config.metadata.infoAvailability}`,
      `Noise: ${config.metadata.noiseLevel}`,
    ].join('\n'),
  );
  return testId;
}

function writeSummary(generatedTests, outputDir, seed) {
  const lines = ['# Form Tests', '', `Seed: ${seed}`, ''];
  for (const test of generatedTests) {
    lines.push(`- ${test.testId}: ${test.config.name}`);
  }
  lines.push('');
  fs.writeFileSync(path.join(outputDir, 'SUMMARY.md'), `${lines.join('\n')}\n`);
}

function normalizeOptions(inputOptions = {}) {
  return {
    count: DEFAULT_TEST_COUNT,
    outputDir: DEFAULT_OUTPUT_DIR,
    clear: true,
    matrix: true,
    complexity: null,
    sourceType: null,
    seed: DEFAULT_SEED,
    selectedIds: null,
    log: true,
    ...inputOptions,
  };
}

async function materializeConfig(config) {
  const nextConfig = JSON.parse(JSON.stringify(config));
  if (nextConfig.info?.document?.receiptAsset) {
    nextConfig.info.document.imageUrl = await buildReceiptImageDataUrl(nextConfig.info.document.receiptAsset);
    delete nextConfig.info.document.receiptAsset;
  }
  if (nextConfig.info?.document?.imageAssetPath) {
    delete nextConfig.info.document.imageAssetPath;
  }
  return nextConfig;
}

function shouldIncludeTest(testId, selectedIds) {
  if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
    return true;
  }
  return selectedIds.includes(testId);
}

async function buildGeneratedTests(inputOptions = {}) {
  const options = normalizeOptions(inputOptions);
  const generatedTests = [];
  const rootRng = createRng(options.seed);

  for (let index = 0; index < options.count; index += 1) {
    const testId = `test-${String(index + 1).padStart(3, '0')}`;
    if (!shouldIncludeTest(testId, options.selectedIds)) {
      continue;
    }

    const testSeed = `${options.seed}:${testId}`;
    const spec = createSpec(index, options, rootRng.fork(`spec-${index}`));
    const config = await materializeConfig(buildConfig(spec, testSeed));
    generatedTests.push({ testId, config });
  }

  if (shouldIncludeTest('test-012', options.selectedIds)) {
    const regressionConfig = await materializeConfig(createChromeCheckoutAxTrapRegressionConfig());
    generatedTests.push({ testId: 'test-012', config: regressionConfig });
  }

  if (shouldIncludeTest('test-013', options.selectedIds)) {
    const expenseRegressionConfig = await materializeConfig(createExpenseReportJsRegressionConfig());
    generatedTests.push({ testId: 'test-013', config: expenseRegressionConfig });
  }

  if (shouldIncludeTest('test-014', options.selectedIds)) {
    const dropdownRegressionConfig = await materializeConfig(createDropdownHeavyVendorIntakeConfig());
    generatedTests.push({ testId: 'test-014', config: dropdownRegressionConfig });
  }

  if (shouldIncludeTest('test-015', options.selectedIds)) {
    const overlayScreenshotConfig = await materializeConfig(createOverlayScreenshotSaveConfig());
    generatedTests.push({ testId: 'test-015', config: overlayScreenshotConfig });
  }

  if (shouldIncludeTest('test-016', options.selectedIds)) {
    const overlayInterpreterFastFillConfig = await materializeConfig(createOverlayInterpreterFastLeadFillConfig());
    generatedTests.push({ testId: 'test-016', config: overlayInterpreterFastFillConfig });
  }

  return generatedTests;
}

async function generateTests(inputOptions = {}) {
  const options = normalizeOptions(inputOptions);
  ensureDir(options.outputDir);
  if (options.clear) {
    clearGenerated(options.outputDir);
  }

  const generatedTests = await buildGeneratedTests(options);
  for (let index = 0; index < generatedTests.length; index += 1) {
    const { testId, config } = generatedTests[index];
    await writeTest(index, config, options.outputDir, testId);
    if (options.log !== false) {
      console.log(`Generated ${testId}: ${config.name} (seed=${config.metadata.seed})`);
    }
  }

  writeSummary(generatedTests, options.outputDir, options.seed);
  if (options.log !== false) {
    console.log(`Wrote ${generatedTests.length} tests to ${options.outputDir}`);
  }
  return generatedTests;
}

async function main() {
  await generateTests(parseArgs());
}

module.exports = {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_SEED,
  DEFAULT_TEST_COUNT,
  buildConfig,
  buildGeneratedTests,
  generateTests,
  normalizeOptions,
  parseArgs,
  summarizeDocument,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
