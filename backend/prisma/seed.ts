import 'dotenv/config';
import bcrypt from 'bcryptjs';
import {
  AgentAvailability,
  ChannelType,
  ConnectionProvider,
  ConnectionStatus,
  PrismaClient,
  UserRole,
} from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log('🌱 Iniciando seed do SMV Sac...');

  // 1. Organização padrão
  const org = await prisma.organization.upsert({
    where: { slug: 'super-megavendas' },
    update: {},
    create: {
      name: 'Super MegaVendas',
      slug: 'super-megavendas',
      plan: 'enterprise',
    },
  });

  // 2. Usuário Admin inicial (mesmas credenciais da demo)
  const adminPasswordHash = await bcrypt.hash('@Smv2025', 10);
  await prisma.user.upsert({
    where: { email: 'ransay@supermegavendas.com' },
    update: {},
    create: {
      organizationId: org.id,
      name: 'Ransay',
      email: 'ransay@supermegavendas.com',
      passwordHash: adminPasswordHash,
      role: UserRole.ADMIN,
      availability: AgentAvailability.ONLINE,
    },
  });

  // 3. Departamentos padrão
  const departmentNames = ['Admin/Financeiro', 'Comercial', 'Marketing', 'Suporte', 'TI', 'Diretoria'];
  const departmentsByName = new Map<string, string>();
  for (const name of departmentNames) {
    const dept = await prisma.department.upsert({
      where: { organizationId_name: { organizationId: org.id, name } },
      update: {},
      create: { organizationId: org.id, name },
    });
    departmentsByName.set(name, dept.id);
  }

  // 4. Etiquetas padrão
  const labels = [
    { name: 'Suporte', color: '#3B82F6' },
    { name: 'VIP', color: '#FACC15' },
    { name: 'Urgente', color: '#EF4444' },
    { name: 'Financeiro', color: '#22C55E' },
    { name: 'Remoto', color: '#A855F7' },
  ];
  for (const label of labels) {
    await prisma.label.upsert({
      where: { organizationId_name: { organizationId: org.id, name: label.name } },
      update: {},
      create: { organizationId: org.id, ...label },
    });
  }

  // 5. Respostas rápidas (/)
  const canned = [
    {
      shortcode: '/ola',
      title: 'Saudação rápida',
      content: 'Olá! Tudo bem? Sou da equipe SMV Sac. Como posso te ajudar hoje?',
    },
    {
      shortcode: '/acesso',
      title: 'Liberação de acesso remoto',
      content: 'Acesso liberado! Pode testar novamente por aí e me confirmar se carregou certinho.',
    },
    {
      shortcode: '/pix',
      title: '2ª via / Pagamento PIX',
      content:
        'Segue o link para emissão da 2ª via ou pagamento via PIX com baixa imediata: https://financeiro.smvsac.com.br',
    },
    {
      shortcode: '/encerrar',
      title: 'Finalizar atendimento',
      content:
        'Perfeito! Fico à disposição sempre que precisar. Vou finalizar este atendimento por aqui. Obrigado!',
    },
  ];
  for (const item of canned) {
    await prisma.cannedResponse.upsert({
      where: { organizationId_shortcode: { organizationId: org.id, shortcode: item.shortcode } },
      update: {},
      create: { organizationId: org.id, ...item },
    });
  }

  // 6. Agente IA padrão
  const existingAi = await prisma.aiAgent.findFirst({
    where: { organizationId: org.id, name: 'Assistente IA SMV Sac' },
  });
  const aiAgent =
    existingAi ??
    (await prisma.aiAgent.create({
      data: {
        organizationId: org.id,
        name: 'Assistente IA SMV Sac',
        autoTriageEnabled: true,
        systemPrompt:
          'Você é o assistente virtual do SMV Sac. Responda em português de forma clara, objetiva e transfira para um atendente humano quando o cliente solicitar contrato, negociação ou suporte avançado.',
      },
    }));

  // 7. Conexões iniciais (idempotente por nome + organização)
  const existingConnCount = await prisma.connection.count({ where: { organizationId: org.id } });
  if (existingConnCount === 0) {
    await prisma.connection.createMany({
      data: [
        {
          organizationId: org.id,
          name: 'Atendimento',
          channel: ChannelType.WEBCHAT,
          provider: ConnectionProvider.WIDGET,
          identifier: 'WebChat • Site SMV',
          defaultDepartmentId: departmentsByName.get('Suporte') ?? null,
          aiAgentId: aiAgent.id,
          status: ConnectionStatus.ACTIVE,
        },
        {
          organizationId: org.id,
          name: 'Marketing',
          channel: ChannelType.WHATSAPP,
          provider: ConnectionProvider.META_CLOUD,
          identifier: '+55 84 8721-9800',
          defaultDepartmentId: departmentsByName.get('Suporte') ?? null,
          status: ConnectionStatus.ACTIVE,
        },
        {
          organizationId: org.id,
          name: 'SUPER MEGAVENDAS',
          channel: ChannelType.WHATSAPP,
          provider: ConnectionProvider.META_CLOUD,
          identifier: '+55 11 91773-5588',
          defaultDepartmentId: departmentsByName.get('Suporte') ?? null,
          status: ConnectionStatus.ACTIVE,
        },
        {
          organizationId: org.id,
          name: 'Instagram Comercial',
          channel: ChannelType.INSTAGRAM,
          provider: ConnectionProvider.META_CLOUD,
          identifier: '@smvsac.oficial',
          defaultDepartmentId: departmentsByName.get('Comercial') ?? null,
          status: ConnectionStatus.ARCHIVED,
        },
      ],
    });
  }

  console.log('✅ Seed concluído com sucesso!');
}

main()
  .catch((err) => {
    console.error('❌ Erro ao executar seed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
