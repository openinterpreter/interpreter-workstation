const PII_COLORS: Record<string, { light: string; dark: string; label: string }> = {
  email:               { light: '#3b82f6', dark: '#60a5fa', label: 'Email' },
  person_full_name:    { light: '#10b981', dark: '#34d399', label: 'Name' },
  person_first_name:   { light: '#84cc16', dark: '#a3e635', label: 'First Name' },
  person_last_name:    { light: '#f59e0b', dark: '#fbbf24', label: 'Last Name' },
  date_of_birth:       { light: '#ef4444', dark: '#f87171', label: 'Date of Birth' },
  phone_number:        { light: '#8b5cf6', dark: '#a78bfa', label: 'Phone' },
  address:             { light: '#ec4899', dark: '#f472b6', label: 'Address' },
  city:                { light: '#8b5cf6', dark: '#a78bfa', label: 'City' },
  postal_code:         { light: '#a855f6', dark: '#c084fc', label: 'Postal Code' },
  ip_address:          { light: '#6366f1', dark: '#818cf8', label: 'IP' },
  ipv4:                { light: '#6366f1', dark: '#818cf8', label: 'IP' },
  ipv6:                { light: '#6366f1', dark: '#818cf8', label: 'IP' },
  credit_card:         { light: '#f59e0b', dark: '#fbbf24', label: 'Card' },
  iban:                { light: '#ef4444', dark: '#f87171', label: 'IBAN' },
  bank_account:        { light: '#f59e0b', dark: '#fbbf24', label: 'Bank Account' },
  organization:        { light: '#06b6d4', dark: '#22d3ee', label: 'Org' },
  location:            { light: '#0891b2', dark: '#0891b2', label: 'Location' },
  national_id_fr:      { light: '#f97316', dark: '#fb923c', label: 'National ID (FR)' },
  national_id_nl:      { light: '#f97316', dark: '#fb923c', label: 'National ID (NL)' },
  national_id_be:      { light: '#f97316', dark: '#fb923c', label: 'National ID (BE)' },
  national_id_at:      { light: '#f97316', dark: '#fb923c', label: 'National ID (AT)' },
  national_id_ie:      { light: '#f97316', dark: '#fb923c', label: 'National ID (IE)' },
  national_id_pt:      { light: '#f97316', dark: '#fb923c', label: 'National ID (PT)' },
  aws_access_key:      { light: '#7f1d1f', dark: '#b91c1c', label: 'AWS Access Key' },
  aws_secret_key:      { light: '#7f1d1f', dark: '#b91c1c', label: 'AWS Secret Key' },
  gcp_credentials:     { light: '#7f1d1f', dark: '#b91c1c', label: 'GCP Credentials' },
  azure_credentials:   { light: '#7f1d1f', dark: '#b91c1c', label: 'Azure Credentials' },
  api_key:             { light: '#7f1d1f', dark: '#b91c1c', label: 'API Key' },
  jwt_token:           { light: '#7f1d1f', dark: '#b91c1c', label: 'JWT Token' },
  bearer_token:        { light: '#7f1d1f', dark: '#b91c1c', label: 'Bearer Token' },
  oauth_token:         { light: '#7f1d1f', dark: '#b91c1c', label: 'OAuth Token' },
  ssh_private_key:     { light: '#7f1d1f', dark: '#b91c1c', label: 'SSH Private Key' },
  gpg_private_key:     { light: '#7f1d1f', dark: '#b91c1c', label: 'GPG Private Key' },
  tls_certificate:     { light: '#7f1d1f', dark: '#b91c1c', label: 'TLS Certificate' },
  db_connection_string:{ light: '#7f1d1f', dark: '#b91c1c', label: 'DB Connection String' },
  env_secret:          { light: '#7f1d1f', dark: '#b91c1c', label: 'Env Secret' },
  internal_hostname:   { light: '#a21caf', dark: '#e9e5ff', label: 'Internal Hostname' },
  internal_url:        { light: '#a21caf', dark: '#e9e5ff', label: 'Internal URL' },
  mac_address:         { light: '#d1d5db', dark: '#4b5563', label: 'MAC Address' },
  cookie_id:           { light: '#d1d5db', dark: '#4b5563', label: 'Cookie ID' },
};

export { PII_COLORS };

export function getPiiColor(category: string): { light: string; dark: string } {
  const color = PII_COLORS[category];
  return color || { light: '#6b7280', dark: '#4b5563' };
}

export function getAllPiiCategories(): string[] {
  return Object.keys(PII_COLORS);
}

export default PII_COLORS;