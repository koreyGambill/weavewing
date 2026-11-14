import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ContextRecords from "../threadInsights/ContextRecords.ts";
import * as MonitoringStore from "../monitoring/MonitoringStore.ts";
import * as MonitoringSnapshot from "../monitoring/MonitoringSnapshot.ts";
import * as MonitoringRunner from "../monitoring/MonitoringRunner.ts";
import * as MonitoringService from "../monitoring/MonitoringService.ts";
import * as MonitoringDialogue from "../monitoring/MonitoringDialogue.ts";
import * as MonitoringDelivery from "../monitoring/MonitoringDelivery.ts";
import * as MonitoringFollowup from "../monitoring/MonitoringFollowup.ts";
import * as ThreadMarks from "../threadWorkspace/ThreadMarks.ts";
import * as ThreadInsights from "../threadInsights/ThreadInsights.ts";
import * as DefaultContext from "../threadInsights/DefaultContext.ts";
import * as McpToolCatalog from "../mcp/McpToolCatalog.ts";
import * as ThreadTimeline from "../threadInsights/ThreadTimeline.ts";
import * as InstructionFootprints from "../threadInsights/InstructionFootprints.ts";
import * as ThreadNotes from "../threadNotes/ThreadNotes.ts";
import * as ThreadWorkspace from "../threadWorkspace/ThreadWorkspace.ts";
import * as TicketTracker from "../ticketTracker/TicketTracker.ts";
import * as ReviewArtifacts from "../reviewArtifacts/ReviewArtifacts.ts";
import * as WorktreeBranchSync from "./WorktreeBranchSync.ts";
import * as GuestShareService from "../guest/GuestShareService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Layer from "effect/Layer";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as AutomationLimits from "../scheduledTasks/AutomationLimits.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as DevelopmentEnvironmentDiscovery from "../developmentEnvironments/DevelopmentEnvironmentDiscovery.ts";
import * as XwingEnvironments from "../xwing/XwingEnvironments.ts";
import * as ProcessRunner from "../processRunner.ts";

export const layerEventInfrastructure = Layer.mergeAll(
  OrchestrationEventStore.layer,
  OrchestrationCommandReceipts.layer,
);

const layerRuntimePolicyProvided = AutomationLimits.runtimePolicyLayer.pipe(
  Layer.provide(RuntimePolicy.layerFromProjectStore.pipe(Layer.provide(ProjectStore.layer))),
);

const layerEventStoreProvided = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provide(layerEventInfrastructure),
);
const layerCommandReceiptStoreProvided = CommandReceiptStore.layerFromApplicationReceipts.pipe(
  Layer.provide(layerEventInfrastructure),
);

const layerStores = Layer.mergeAll(
  layerEventInfrastructure,
  layerEventStoreProvided,
  ProjectionStore.layer,
  ProjectStore.layer,
  layerCommandReceiptStoreProvided,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
);

export const layerEventSink = EventSink.layerFromStores.pipe(Layer.provide(layerStores));
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStores),
);
const layerLegacyV1ThreadImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(layerEventSink),
);

export const layerProjectService = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      ProjectionStore.layer,
      layerEventSink,
      IdAllocator.layer,
      layerLegacyV1ThreadImporterProvided,
    ),
  ),
);

const layerProviderEventIngestorProvided = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
      ThreadCommandExecutor.layer,
      GitVcsDriver.layer,
    ),
  ),
);

const layerCheckpointServiceProvided = CheckpointService.layer.pipe(
  Layer.provide(Layer.merge(IdAllocator.layer, ProjectionStore.layer)),
);
const layerContextHandoffServiceProvided = ContextHandoffService.layer.pipe(
  Layer.provide(Layer.merge(IdAllocator.layer, ServerEnvironment.layerIdentity)),
);

const layerProviderSwitchServiceProvided = ProviderSwitchService.layer.pipe(
  Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
);

const layerCommandOutputHubProvided = CommandOutputHub.layer.pipe(
  Layer.provide(Layer.merge(layerEventSink, ProjectionStore.layer)),
);

const layerProviderSessionManagerProvided = ProviderSessionManager.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      InstructionFootprints.layer,
      layerCommandOutputHubProvided,
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
      layerEventSink,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      ProjectionStore.layer,
      ProviderInstallationGate.layer,
    ),
  ),
);

const layerProviderAuthServiceProvided = ProviderAuthService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);

const layerRunExecutionServiceProvided = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      PreviewAgentActivity.layer,
      layerCheckpointServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      TurnItemPositionStore.layer,
      ThreadCommandExecutor.layer,
    ),
  ),
);

const layerProviderTurnStartServiceProvided = ProviderTurnStartService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ServerEnvironment.layerIdentity,
      layerContextHandoffServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      layerProviderAuthServiceProvided,
      layerRunExecutionServiceProvided,
      layerRuntimePolicyProvided,
      TurnItemPositionStore.layer,
    ),
  ),
);

const layerProviderTurnControlServiceProvided = ProviderTurnControlService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEventSink,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      ServerEnvironment.layerIdentity,
    ),
  ),
);
const layerRuntimeRequestServiceProvided = RuntimeRequestService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);
const layerCheckpointRollbackServiceProvided = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      layerCheckpointServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      ThreadCommandExecutor.layer,
      layerRuntimePolicyProvided,
    ),
  ),
);
const layerCheckpointCaptureServiceProvided = CheckpointCaptureService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);
const layerRunFinalizationServiceProvided = RunFinalizationService.layer.pipe(
  Layer.provide(Layer.merge(layerCheckpointCaptureServiceProvided, ProjectionStore.layer)),
);

const layerOrchestratorProvided = Orchestrator.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ServerEnvironment.layerIdentity,
      layerCheckpointServiceProvided,
      CommandPolicy.layer,
      layerStores,
      layerEventSink,
      layerCommandReceiptStoreProvided,
      layerContextHandoffServiceProvided,
      IdAllocator.layer,
      ProjectStore.layer,
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
      // Reuse the continuation worker's layer reference so memoization shares one request queue.
      ProviderContinuationRequests.layer,
      layerProviderEventIngestorProvided,
      layerRuntimePolicyProvided,
      layerProviderSessionManagerProvided,
      layerProviderSwitchServiceProvided,
      layerRunExecutionServiceProvided,
      ThreadForkService.layer,
    ),
  ),
);

// One scanner serves the wizard's scan and imports, so imports can reuse its candidates.
const layerAgentSessionScannerProvided = AgentSessionScanner.layer.pipe(
  Layer.provide(ProviderSessionRuntime.layer),
);
const layerAgentSessionImporterProvided = AgentSessionImporter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerAgentSessionScannerProvided,
      layerProjectService,
      layerOrchestratorProvided,
      layerEventSink,
      IdAllocator.layer,
      ProviderSessionRuntime.layer,
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
      ThreadCommandExecutor.layer,
    ),
  ),
);

const layerThreadManagementProvided = ThreadManagementService.layerWithLegacyImporter.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerOrchestratorProvided,
      layerLegacyV1ThreadImporterProvided,
      layerCommandReceiptStoreProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);
export const layerProjectSetupScriptRunner = ProjectSetupScriptRunner.layer.pipe(
  Layer.provide(layerProjectService),
  // Whether a thread came from a linked environment, which skips setup.
  Layer.provide(ProjectionStore.layer),
);
const layerManagedProjectFoldersProvided = ManagedProjectFolders.layer.pipe(
  Layer.provide(layerProjectService),
);
export const layerDevelopmentEnvironmentDiscoveryProvided =
  DevelopmentEnvironmentDiscovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        XwingEnvironments.layer.pipe(Layer.provide(ProcessRunner.layer)),
        layerOrchestratorProvided,
        ProjectionStore.layer,
        GitVcsDriver.layer,
        ProcessRunner.layer,
      ),
    ),
  );

const layerThreadLaunchProvided = ThreadLaunchService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProjectService,
      layerProjectSetupScriptRunner,
      layerManagedProjectFoldersProvided,
      layerThreadManagementProvided,
      layerCommandReceiptStoreProvided,
      layerEventSink,
      IdAllocator.layer,
    ),
  ),
);
const layerSecretRequestsProvided = SecretRequests.layer.pipe(
  Layer.provide(layerThreadManagementProvided),
);
const layerContextRecordsProvided = ContextRecords.layer.pipe(
  Layer.provide(InstructionFootprints.layer),
);
const layerMonitoringSnapshotProvided = MonitoringSnapshot.layer.pipe(
  Layer.provide(layerContextRecordsProvided),
);
const layerThreadWorkspaceProvided = ThreadWorkspace.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerOrchestratorProvided,
      layerThreadManagementProvided,
      TicketTracker.layer.pipe(Layer.provide(ProcessRunner.layer)),
    ),
  ),
);
const layerMonitoringDeliveryProvided = MonitoringDelivery.layer.pipe(
  Layer.provide(layerThreadWorkspaceProvided),
  Layer.provide(layerThreadManagementProvided),
);
const layerMonitoringRunnerProvided = MonitoringRunner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      MonitoringStore.layer,
      layerMonitoringSnapshotProvided,
      layerMonitoringDeliveryProvided,
    ),
  ),
);
const layerMonitoringFollowupProvided = MonitoringFollowup.layer.pipe(
  Layer.provide(Layer.mergeAll(layerMonitoringRunnerProvided, layerMonitoringSnapshotProvided)),
);
const layerMonitoringDialogueProvided = MonitoringDialogue.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      MonitoringStore.layer,
      layerMonitoringFollowupProvided,
      layerMonitoringDeliveryProvided,
    ),
  ),
);
const layerScheduledTaskProvided = ScheduledTaskService.layer.pipe(
  Layer.provide(GitVcsDriver.layer),
  Layer.provide(layerMonitoringRunnerProvided),
  Layer.provide(
    Layer.mergeAll(
      layerThreadLaunchProvided,
      layerThreadManagementProvided,
      layerManagedProjectFoldersProvided,
      layerSecretRequestsProvided,
    ),
  ),
);
const layerAutomationLimitsProvided = AutomationLimits.layer.pipe(
  Layer.provide(layerThreadManagementProvided),
);
const layerProviderContinuationWorkerProvided = ProviderContinuationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProviderContinuationRequests.layer,
      layerThreadManagementProvided,
      IdAllocator.layer,
    ),
  ),
);
const layerThreadTitleRegenerationProvided = ThreadTitleRegenerationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreadManagementProvided,
      ProjectStore.layer,
      TextGeneration.layer.pipe(Layer.provide(ProviderInstallationGate.layer)),
    ),
  ),
);
const layerEffectExecutorProvided = EffectWorker.layerExecutor.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerRunFinalizationServiceProvided,
      layerCheckpointRollbackServiceProvided,
      layerProviderSessionManagerProvided,
      layerProviderTurnControlServiceProvided,
      layerProviderTurnStartServiceProvided,
      layerRuntimeRequestServiceProvided,
      layerThreadTitleRegenerationProvided,
      layerThreadManagementProvided,
    ),
  ),
);
const layerEffectWorkerProvided = EffectWorker.layer.pipe(
  Layer.provide(Layer.merge(layerStores, layerEffectExecutorProvided)),
);
const layerProviderRuntimeRecoveryProvided = ProviderRuntimeRecoveryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEffectWorkerProvided,
      layerStores,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);

const layerMcpAppRequestsProvided = McpAppRequests.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      layerOrchestratorProvided,
      layerThreadManagementProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);

export const layer = Layer.mergeAll(
  layerCommandOutputHubProvided,
  layerAutomationLimitsProvided,
  layerOrchestratorProvided,
  layerMcpAppRequestsProvided,
  layerThreadManagementProvided,
  layerEffectWorkerProvided,
  layerProviderSessionManagerProvided,
  layerProviderAuthServiceProvided,
  layerProviderRuntimeRecoveryProvided,
  layerProjectionMaintenanceProvided,
  layerLegacyV1ThreadImporterProvided,
);

export const layerProduction = Layer.mergeAll(
  layerMonitoringDialogueProvided,
  MonitoringService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        MonitoringStore.layer,
        layerMonitoringRunnerProvided,
        layerScheduledTaskProvided,
        layerThreadManagementProvided,
      ),
    ),
  ),
  WorktreeBranchSync.layer.pipe(
    Layer.provide(Layer.merge(layerThreadManagementProvided, ProjectionStore.layer)),
  ),
  layer.pipe(
    Layer.provide(layerProjectService),
    Layer.provide(layerManagedProjectFoldersProvided),
    Layer.provide(layerDevelopmentEnvironmentDiscoveryProvided),
  ),
  layerProjectService,
  layerManagedProjectFoldersProvided,
  layerThreadLaunchProvided,
  layerScheduledTaskProvided,
  layerSecretRequestsProvided,
  GuestShareService.layer.pipe(
    Layer.provide(Layer.merge(layerOrchestratorProvided, layerCommandOutputHubProvided)),
  ),
  UsageLimitRecoveryWorker.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectionStore.layer,
        layerThreadManagementProvided,
        layerOrchestratorProvided,
      ),
    ),
  ),
  layerProviderContinuationWorkerProvided,
  layerAgentSessionScannerProvided,
  layerAgentSessionImporterProvided,
  ThreadMarks.layer.pipe(
    Layer.provide(Layer.merge(layerOrchestratorProvided, ProjectionStore.layer)),
  ),
  layerContextRecordsProvided,
  ThreadTimeline.layer,
  ThreadInsights.layer.pipe(
    Layer.provide(Layer.merge(layerOrchestratorProvided, InstructionFootprints.layer)),
  ),
  DefaultContext.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerOrchestratorProvided,
        InstructionFootprints.layer,
        McpAppModelContext.layer,
        layerManagedProjectFoldersProvided,
        layerProjectService,
        McpToolCatalog.layer,
      ),
    ),
  ),
  ThreadNotes.layer.pipe(
    Layer.provide(Layer.merge(layerOrchestratorProvided, layerThreadManagementProvided)),
  ),
  layerThreadWorkspaceProvided,
  ReviewArtifacts.layer.pipe(
    Layer.provide(Layer.merge(layerOrchestratorProvided, layerThreadManagementProvided)),
  ),
  EffectOutbox.layerPruneWorker.pipe(Layer.provide(EffectOutbox.layer)),
).pipe(
  Layer.provide(ResourceCleanupService.layer.pipe(Layer.provide(layerScheduledTaskProvided))),
  Layer.provide(Scheduler.layer),
  Layer.provideMerge(layerEventInfrastructure),
);
