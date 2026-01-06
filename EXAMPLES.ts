/**
 * Exemplos de uso das novas classes refatoradas
 * 
 * Este arquivo demonstra como usar os novos serviços e handlers
 */

// ============================================
// 1. Usando o Logger Service
// ============================================
import { logger } from "./services/logger.service";

// Log simples
logger.info("Mensagem de informação");

// Log com dados adicionais
logger.info("Usuário autenticado", { userId: 123, email: "user@example.com" });

// Log de erro
logger.error("Erro ao processar", new Error("Detalhes do erro"));

// Log de aviso
logger.warn("Atenção: recurso será depreciado");


// ============================================
// 2. Usando Constantes
// ============================================
import { APP_CONFIG, RABBITMQ_QUEUES, WHATSAPP_JID } from "./config/constants";

// Usar constantes em vez de strings hardcoded
console.log(`Porta: ${APP_CONFIG.DEFAULT_WEBSOCKET_PORT}`);

// Criar JID do WhatsApp
const jid = WHATSAPP_JID.CONTACT("5511999999999");
console.log(jid); // 5511999999999@c.us

// Usar nome das filas
const queueName = RABBITMQ_QUEUES.SESSION_START;


// ============================================
// 3. Usando File Utils
// ============================================
import { FileUtils } from "./utils/file.utils";

async function exemploFileUtils() {
  // Criar diretório
  await FileUtils.ensureDirectoryExists("./data");

  // Listar arquivos
  const files = await FileUtils.listFiles("./sessions");
  console.log("Arquivos:", files);

  // Remover arquivo com segurança
  await FileUtils.safeUnlink("./temp/arquivo.txt");
}


// ============================================
// 4. Usando Validation Utils
// ============================================
import { ValidationUtils } from "./utils/validation.utils";

// Validar número de telefone
const isValid = ValidationUtils.isValidPhoneNumber("11999999999");
console.log("Telefone válido:", isValid);

// Normalizar número
const normalized = ValidationUtils.normalizePhoneNumber("+55 (11) 99999-9999");
console.log("Normalizado:", normalized); // 5511999999999

// Validar base64
const isBase64 = ValidationUtils.isValidBase64Image("data:image/png;base64,iVBOR...");


// ============================================
// 5. Estrutura de um Handler Personalizado
// ============================================
import { RabbitMQService } from "./services/rabbitmq.service";
import { SocketService } from "./services/socket.service";

class CustomHandler {
  constructor(
    private readonly rabbitMQ: RabbitMQService,
    private readonly socket: SocketService
  ) {}

  async handleEvent(data: any): Promise<void> {
    logger.info("Processando evento customizado");
    
    // Sua lógica aqui
    await this.rabbitMQ.publishSessionStarted(data.token);
    
    this.socket.emitSessionUpdate({
      clientId: data.clientId,
      data: {
        type: "custom_event",
        metadata: {}
      }
    });
  }
}


// ============================================
// 6. Estrutura de um Service Personalizado
// ============================================
export class CustomService {
  private readonly serviceName: string;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    logger.info(`${serviceName} inicializado`);
  }

  async execute(): Promise<void> {
    try {
      // Sua lógica aqui
      logger.info(`Executando ${this.serviceName}`);
      
      // Validações
      if (!ValidationUtils.isValidToken("abc123")) {
        throw new Error("Token inválido");
      }

      // Operações de arquivo
      await FileUtils.ensureDirectoryExists("./data");

      logger.info(`${this.serviceName} concluído`);
    } catch (error) {
      logger.error(`Erro em ${this.serviceName}`, error);
      throw error;
    }
  }
}


// ============================================
// 7. Pattern de Injeção de Dependências
// ============================================
class ServiceA {
  doSomething(): void {
    logger.info("Service A fazendo algo");
  }
}

class ServiceB {
  constructor(private readonly serviceA: ServiceA) {}

  execute(): void {
    this.serviceA.doSomething();
    logger.info("Service B executado");
  }
}

// Uso
const serviceA = new ServiceA();
const serviceB = new ServiceB(serviceA);
serviceB.execute();


// ============================================
// 8. Pattern de Error Handling Consistente
// ============================================
import Sentry from "@sentry/node";

async function operacaoComErro(): Promise<void> {
  try {
    // Operação que pode falhar
    throw new Error("Algo deu errado");
  } catch (error) {
    // 1. Log do erro
    logger.error("Erro na operação", error);
    
    // 2. Enviar para Sentry
    Sentry.captureException(error);
    
    // 3. Re-throw se necessário
    throw error;
  }
}


// ============================================
// 9. Como Adicionar um Novo Handler
// ============================================

/**
 * Passo a passo para adicionar novo handler:
 * 
 * 1. Criar arquivo em src/handlers/meu-handler.handler.ts
 * 2. Implementar a lógica do handler
 * 3. Injetar dependências necessárias
 * 4. Usar no WhatsAppSessionService
 * 
 * Exemplo:
 */

// src/handlers/status.handler.ts
export class StatusHandler {
  constructor(
    private readonly sessionToken: string
  ) {}

  async handleStatusUpdate(status: string): Promise<void> {
    logger.info(`Status atualizado para ${status} - Session: ${this.sessionToken}`);
    // Sua lógica aqui
  }
}


// ============================================
// 10. Como Adicionar Novas Constantes
// ============================================

/**
 * Adicionar em src/config/constants.ts:
 * 
 * export const NOVA_CATEGORIA = {
 *   VALOR_1: "valor1",
 *   VALOR_2: "valor2",
 * } as const;
 * 
 * Usar:
 * import { NOVA_CATEGORIA } from "./config/constants";
 * console.log(NOVA_CATEGORIA.VALOR_1);
 */

export {};
