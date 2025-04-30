export interface ConfirmationAccountEmailProps {
  to: string;
  name: string;
  verification_code: string;
}

export interface LoginUrlEmailProps {
  to: string;
  name: string;
  url: string;
}

export interface CredentialsEmailProps {
  to: string;
  name: string;
  client_id: string;
  client_secret: string;
}