# 📱 WTSAPI Microservice

Microserviço responsável pelo gerenciamento de sessões do WhatsApp e processamento de mensagens, construído com **TypeScript** e a biblioteca **Baileys**. Parte integrante do ecossistema **Blibsend**.

## 📋 Índice

- [Visão Geral](#-visão-geral)
- [Arquitetura](#-arquitetura)
- [Tecnologias](#-tecnologias)
- [Pré-requisitos](#-pré-requisitos)
- [Instalação](#-instalação)
- [Configuração](#-configuração)
- [Estrutura do Projeto](#-estrutura-do-projeto)
- [Filas e Eventos](#-filas-e-eventos)
- [Tipos de Mensagem](#-tipos-de-mensagem)
- [Deploy](#-deploy)
- [Scripts Disponíveis](#-scripts-disponíveis)
- [Monitoramento](#-monitoramento)
- [Licença](#-licença)

## 🔍 Visão Geral

O **WTSAPI Microservice** é um serviço headless que conecta ao WhatsApp via protocolo WebSocket (Baileys) e gerencia múltiplas sessões simultaneamente. Ele atua como uma ponte entre o backend principal (Blibsend) e o WhatsApp, processando comandos de envio/recebimento de mensagens através de filas gerenciadas pelo **PgBoss**.

### Principais Funcionalidades

- ✅ Gerenciamento multi-sessão de WhatsApp
- ✅ Envio de mensagens de texto com simulação de digitação
- ✅ Envio de imagens (com suporte a múltiplas imagens)
- ✅ Envio de áudio com simulação de gravação
- ✅ Envio de stickers
- ✅ Recebimento de mensagens (texto, áudio/voz)
- ✅ Suporte a mensagens de grupo e newsletter
- ✅ Reconexão automática com retry controlado
- ✅ Geração e envio de QR Code para autenticação
- ✅ Graceful shutdown com encerramento correto de conexões
- ✅ Integração com Oban (Elixir) via tabela `oban_jobs`

## 🏗 Arquitetura

```
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│  Blibsend        │       │  WTSAPI          │       │  WhatsApp        │
│  Backend         │◄─────►│  Microservice    │◄─────►│  (Baileys WS)    │
│  (Elixir/Oban)   │       │  (Node.js)       │       │                  │
└──────────────────┘       └──────────────────┘       └──────────────────┘
        │                          │
        │                          │
        ▼                          ▼
┌──────────────────────────────────────────────┐
│              PostgreSQL                       │
│  ┌────────────┐  ┌─────────────────────────┐ │
│  │ oban_jobs   │  │ pgboss (filas internas) │ │
│  └────────────┘  └─────────────────────────┘ │
│  ┌──────────────────┐                        │
│  │ sessions_cache    │                        │
│  └──────────────────┘                        │
└──────────────────────────────────────────────┘
```

O serviço se comunica com o backend Blibsend através de:

- **PgBoss**: filas de trabalho para receber comandos (criar sessão, enviar mensagem, etc.)
- **Oban Jobs** (`oban_jobs`): inserção direta na tabela para notificar eventos ao backend Elixir (QR code, sessão conectada, mensagem recebida, etc.)
- **sessions_cache**: tabela PostgreSQL para persistência de metadados de sessão

## 🛠 Tecnologias

| Tecnologia | Versão | Uso |
|---|---|---|
| **Node.js** | 22+ | Runtime |
| **TypeScript** | ^5.8 | Linguagem |
| **Baileys** | 7.0.0-rc.9 | Cliente WhatsApp Web (protocolo WS) |
| **PgBoss** | ^12.5 | Gerenciamento de filas via PostgreSQL |
| **PostgreSQL** | — | Banco de dados (filas, cache de sessão, eventos Oban) |
| **Pino** | ^9.7 | Logging estruturado |
| **Sentry** | ^10.7 | Monitoramento de erros |
| **PM2** | — | Gerenciamento de processos em produção |
| **pnpm** | — | Gerenciador de pacotes |

## 📦 Pré-requisitos

- **Node.js** >= 22
- **pnpm** instalado globalmente (`npm install -g pnpm`)
- **PostgreSQL** acessível com as tabelas necessárias:
  - `oban_jobs` (utilizada pelo backend Elixir/Oban)
  - `sessions_cache` (criada manualmente ou por migration)
  - Schema `pgboss` (criado automaticamente pelo PgBoss com `migrate: true`)
- **PM2** para ambiente de produção (`npm install -g pm2`)

## 🚀 Instalação

```bash
# Clonar o repositório
git clone https://github.com/JoaoPalmasBR/wtsapi_microservice.git
cd wtsapi_microservice

# Instalar dependências
pnpm install

# Copiar o arquivo de variáveis de ambiente
cp .env.example .env
```

## ⚙ Configuração

### Variáveis de Ambiente

Crie um arquivo `.env` na raiz do projeto com as seguintes variáveis:

| Variável | Descrição | Exemplo |
|---|---|---|
| `NODE_ENV` | Ambiente de execução | `development` ou `production` |
| `DATABASE_URL` | String de conexão PostgreSQL | `postgresql://user:pass@host:5432/dbname?schema=public` |

### Tabela `sessions_cache`

Certifique-se de que a tabela existe no banco de dados:

```sql
CREATE TABLE IF NOT EXISTS sessions_cache (
  token VARCHAR(255) PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);
```

## 📁 Estrutura do Projeto

```
wtsapi_microservice/
├── .github/
│   └── workflows/
│       └── deploy.yml          # Pipeline CI/CD (GitHub Actions)
├── src/
│   ├── @types/
│   │   └── env.d.ts            # Tipagem das variáveis de ambiente
│   ├── config/
│   │   └── constants.ts        # Constantes, chaves de filas, configurações
│   ├── dtos/
│   │   └── whatsapp.ts         # DTO de envio de mensagens (SendMessageDto)
│   ├── libs/
│   │   ├── logger.ts           # Logger Pino (usado internamente pelo Baileys)
│   │   ├── pg-boss.ts          # Instância e configuração do PgBoss
│   │   ├── pq.ts               # Pool PostgreSQL, publishEvent, cache de sessão
│   │   └── sentry.ts           # Inicialização do Sentry
│   ├── services/
│   │   └── logger.service.ts   # Serviço de logging com prefixo consistente
│   ├── types/
│   │   ├── contact.types.ts    # Tipo ContactDto
│   │   └── session.types.ts    # Interfaces de sessão e serviços
│   ├── utils/
│   │   ├── file.utils.ts       # Utilitários de sistema de arquivos
│   │   ├── session-cache.ts    # Cache de sessões em memória
│   │   ├── strings.ts          # Utilitários de string (camelToSnakeCase)
│   │   └── validation.utils.ts # Utilitários de validação
│   ├── main.ts                 # Ponto de entrada: bootstrap, graceful shutdown
│   └── whatsapp.ts             # Serviço principal: sessões, envio/recebimento
├── sessions/                   # Arquivos de autenticação das sessões (gitignored)
├── temp/                       # Arquivos temporários de mídia (gitignored)
├── logs/                       # Logs da aplicação
├── .env.example                # Exemplo de variáveis de ambiente
├── ecosystem.config.js         # Configuração PM2 para produção
├── package.json
├── pnpm-lock.yaml
└── tsconfig.json
```

## 📨 Filas e Eventos

### Filas de Consumo (PgBoss → WTSAPI)

O microserviço escuta as seguintes filas do PgBoss:

| Fila | Descrição |
|---|---|
| `wtsapi.session.create` | Criação de uma nova sessão |
| `wtsapi.session.start.main` | Inicialização de uma sessão existente |
| `wtsapi.{token}.send.message` | Envio de mensagem individual (por sessão) |
| `wtsapi.{token}.group.send.message` | Envio de mensagem para grupo (por sessão) |
| `wtsapi.{token}.session.manager` | Comandos de gerenciamento (ex: desconectar sessão) |

### Eventos Publicados (WTSAPI → Oban/Backend)

Eventos inseridos na tabela `oban_jobs` para processamento pelo backend Elixir:

| Worker (queue_fun) | Descrição |
|---|---|
| `BlibsendBackend.Queues.Sessions.QueueQrCodeReceived` | QR Code gerado para autenticação |
| `BlibsendBackend.Queues.Sessions.QueueStatusConnected` | Sessão conectada com sucesso |
| `BlibsendBackend.Queues.Sessions.QueueStatusDisconnected` | Sessão desconectada |
| `BlibsendBackend.Queues.Sessions.QueueDisableAllSessions` | Desabilitar todas as sessões (ao iniciar) |
| `BlibsendBackend.Queues.Sessions.QueueSendMessageToWebhook` | Mensagem recebida encaminhada ao webhook |
| `BlibsendBackend.Queues.Sessions.QueueUpdateOrCreateGroupsInfo` | Informações de grupo atualizadas |

## 💬 Tipos de Mensagem

### Envio

| Tipo | Descrição | Simulação |
|---|---|---|
| `text` | Mensagem de texto | Digitando → composing → envio |
| `image` | Imagem (base64, suporta múltiplas) | Presence subscribe → envio |
| `audio` | Áudio (base64) | Recording → tempo proporcional → envio |
| `sticker` | Sticker/figurinha (base64) | Presence subscribe → envio |

### Recebimento

| Tipo | Origem | Encaminhamento |
|---|---|---|
| `text` | Chat direto | Webhook via Oban |
| `voice` | Áudio/voz de chat direto | Webhook via Oban (base64) |
| `group` | Mensagem de grupo | Webhook via Oban |
| `newsletter` | Newsletter/canal | Webhook via Oban |

## 🚢 Deploy

O deploy é automatizado via **GitHub Actions** no push para a branch `main`.

### Pipeline CI/CD

1. **Criação do `.env`** — Conecta via SSH ao servidor e gera o arquivo `.env` com secrets
2. **Atualização do código** — `git pull`, reinstala dependências com `pnpm install`
3. **Build e restart** — `pnpm build` (TypeScript → JavaScript) e `pm2 restart`

### Deploy Manual

```bash
# No servidor de produção
cd /root/blibsend/wtsapi_microservice

# Atualizar código
git pull origin main

# Instalar dependências
pnpm install

# Build
pnpm build

# Reiniciar com PM2
pm2 restart ecosystem.config.js
pm2 save
```

## 📜 Scripts Disponíveis

| Script | Comando | Descrição |
|---|---|---|
| `dev` | `pnpm dev` | Executa em modo desenvolvimento (ts-node) |
| `dev:watch` | `pnpm dev:watch` | Desenvolvimento com hot-reload (nodemon) |
| `start` | `pnpm start` | Executa a partir do TypeScript (ts-node) |
| `start:prod` | `pnpm start:prod` | Executa o build compilado (`dist/main.js`) |
| `build` | `pnpm build` | Compila TypeScript para JavaScript (`dist/`) |

## 📊 Monitoramento

- **Sentry**: Erros e exceções são capturados automaticamente e enviados para o painel Sentry do projeto `simplix-wts-service`
- **PM2**: Logs e métricas de processo (memória limitada a 550MB com restart automático)
- **Logs internos**: Serviço de logging com prefixo `WTS_SERVICE` para fácil filtragem
- **Status de sessões**: Log periódico (a cada 5 minutos) com contagem de sessões por status (open/connecting/closed)

## 🔄 Resiliência

O serviço implementa diversos mecanismos de resiliência:

- **Reconexão automática**: Até 5 tentativas de reconexão por sessão em caso de desconexão
- **Graceful shutdown**: Encerramento controlado via `SIGINT`/`SIGTERM` com fechamento adequado do PgBoss e pool de conexões
- **Cleanup automático**: Limpeza de sessões fechadas a cada 5 minutos
- **Restart de sessões**: Verificação e restart de sessões fechadas a cada 15 minutos
- **Tratamento de exceções globais**: `unhandledRejection` e `uncaughtException` capturados

## 📄 Licença

Este projeto está licenciado sob a licença **MIT**. Consulte o arquivo [LICENSE](LICENSE) para mais detalhes.

---

**Autor:** Davyd Cardoso
