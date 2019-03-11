import { FormField, MenuItem, NotificationType, SlidingPanel, Tab, Tabs, TopBarFilter } from 'argo-ui';
import * as classNames from 'classnames';
import * as PropTypes from 'prop-types';
import * as React from 'react';
import { Checkbox, Form, FormApi, Text } from 'react-form';
import { RouteComponentProps } from 'react-router';
import { Observable } from 'rxjs';

const jsonMergePatch = require('json-merge-patch');

import { DataLoader, EmptyState, ErrorNotification, ObservableQuery, Page, Paginate, YamlEditor } from '../../../shared/components';
import { AppContext } from '../../../shared/context';
import * as appModels from '../../../shared/models';
import { AppDetailsPreferences, AppsDetailsViewType, services } from '../../../shared/services';

import { ApplicationConditions } from '../application-conditions/application-conditions';
import { ApplicationDeploymentHistory } from '../application-deployment-history/application-deployment-history';
import { ApplicationNodeInfo } from '../application-node-info/application-node-info';
import { ApplicationOperationState } from '../application-operation-state/application-operation-state';
import { ApplicationParameters } from '../application-parameters/application-parameters';
import { ApplicationResourceEvents } from '../application-resource-events/application-resource-events';
import { ApplicationResourceTree } from '../application-resource-tree/application-resource-tree';
import { ApplicationStatusPanel } from '../application-status-panel/application-status-panel';
import { ApplicationSummary } from '../application-summary/application-summary';
import { PodsLogsViewer } from '../pod-logs-viewer/pod-logs-viewer';
import * as AppUtils from '../utils';
import { isSameNode, nodeKey, ResourceTreeNode } from '../utils';
import { ApplicationResourceList } from './application-resource-list';

require('./application-details.scss');

function resourcesFromSummaryInfo(application: appModels.Application, roots: appModels.ResourceNode[]): ResourceTreeNode[] {
    const rootByKey = new Map<string, ResourceTreeNode>();
    for (const node of roots || []) {
        rootByKey.set(nodeKey(node), node);
    }

    return (application.status.resources || []).map((summary) => {
        const root = rootByKey.get(nodeKey(summary));
        return {
            name: summary.name,
            namespace: summary.namespace || application.metadata.namespace,
            kind: summary.kind,
            group: summary.group,
            version: summary.version,
            children: root && root.children || [],
            status: summary.status,
            health: summary.health,
            hook: summary.hook,
            info: [],
            resourceVersion: root && root.resourceVersion || '',
        };
    });
}

export class ApplicationDetails extends React.Component<RouteComponentProps<{ name: string; }>, {page: number}> {

    public static contextTypes = {
        apis: PropTypes.object,
    };

    private formApi: FormApi;
    private loader: DataLoader<{application: appModels.Application, resources: ResourceTreeNode[]}>;

    constructor(props: RouteComponentProps<{ name: string; }>) {
        super(props);
        this.state = { page: 0 };
    }

    private get showOperationState() {
        return new URLSearchParams(this.props.history.location.search).get('operation') === 'true';
    }

    private get showConditions() {
        return new URLSearchParams(this.props.history.location.search).get('conditions') === 'true';
    }

    private get selectedRollbackDeploymentIndex() {
        return parseInt(new URLSearchParams(this.props.history.location.search).get('rollback'), 10);
    }

    private get selectedNodeInfo() {
        const nodeContainer = { key: '', container: 0 };
        const node = new URLSearchParams(this.props.location.search).get('node');
        if (node) {
            const parts = node.split(':');
            nodeContainer.key = parts.slice(0, 4).join(':');
            nodeContainer.container = parseInt(parts[4] || '0', 10);
        }
        return nodeContainer;
    }

    private get selectedNodeKey() {
        const nodeContainer = this.selectedNodeInfo;
        return nodeContainer.key;
    }

    public render() {
        return (
            <ObservableQuery>
            {(q) => (
            <DataLoader
                errorRenderer={(error) => <Page title='Application Details'>{error}</Page>}
                loadingRenderer={() => <Page title='Application Details'>Loading...</Page>}
                input={this.props.match.params.name}
                ref={(loader) => this.loader  = loader}
                load={(name) => Observable.combineLatest(this.loadAppInfo(name), services.viewPreferences.getPreferences(), q).map((items) => {
                    const pref = items[1].appDetails;
                    const params = items[2];
                    if (params.get('resource') != null) {
                        pref.resourceFilter = params.get('resource').split(',').filter((item) => !!item);
                    }
                    if (params.get('view') != null) {
                        pref.view = params.get('view') as AppsDetailsViewType;
                    }
                    return {...items[0], pref};
                })}>

                {({application, resources, pref}: {application: appModels.Application, resources: ResourceTreeNode[], pref: AppDetailsPreferences}) => {
                    const kindsSet = new Set<string>();
                    const toProcess: ResourceTreeNode[] = [...resources || []];
                    const treeFilter = this.getTreeFilter(pref.resourceFilter);
                    while (toProcess.length > 0) {
                        const next = toProcess.pop();
                        kindsSet.add(next.kind);
                        (next.children || []).forEach((child) => toProcess.push(child));
                    }
                    treeFilter.kind.forEach((kind) => { kindsSet.add(kind); });
                    const kinds = Array.from(kindsSet);
                    const noKindsFilter = pref.resourceFilter.filter((item) => item.indexOf('kind:') !== 0);
                    const refreshing = application.metadata.annotations && application.metadata.annotations[appModels.AnnotationRefreshKey];

                    const filter: TopBarFilter<string> = {
                        items: [
                            { content: () => <span>Sync</span> },
                            { value: 'sync:Synced', label: 'Synced' },
                            // Unhealthy includes 'Unknown' and 'OutOfSync'
                            { value: 'sync:OutOfSync', label: 'OutOfSync' },
                            { content: () => <span>Health</span> },
                            { value: 'health:Healthy', label: 'Healthy' },
                            // Unhealthy includes 'Unknown', 'Progressing', 'Degraded' and 'Missing'
                            { value: 'health:Unhealthy', label: 'Unhealthy' },
                            { content: (setSelection) => (
                                <div>
                                    Kinds <a onClick={() => setSelection(noKindsFilter.concat(kinds.map((kind) => `kind:${kind}`)))}>all</a> / <a
                                        onClick={() => setSelection(noKindsFilter)}>none</a>
                                </div>
                            ) },
                            ...kinds.sort().map((kind) => ({ value: `kind:${kind}`, label: kind })),
                        ],
                        selectedValues: pref.resourceFilter,
                        selectionChanged: (items) => {
                            this.appContext.apis.navigation.goto('.', { resource: `${items.join(',')}`});
                            services.viewPreferences.updatePreferences({ appDetails: { ...pref, resourceFilter: items } });
                        },
                    };

                    const appNodesByName = this.groupAppNodesByKey(application, resources);
                    const selectedItem = this.selectedNodeKey && appNodesByName.get(this.selectedNodeKey) || null;
                    const isAppSelected = selectedItem === application;
                    const selectedNode = !isAppSelected && selectedItem as ResourceTreeNode;
                    const operationState = application.status.operationState;
                    const conditions = application.status.conditions || [];
                    const deployParam = new URLSearchParams(this.props.history.location.search).get('deploy');
                    const showDeployPanel = !!deployParam;
                    const deployResIndex = deployParam && resources.findIndex((item) => {
                        return nodeKey(item) === deployParam;
                    });
                    const filteredRes = application.status.resources.filter((res) => {
                        const resNode: ResourceTreeNode = {...res, root: null, info: null, children: null, resourceVersion: ''};
                        resNode.root = resNode;
                        return this.filterTreeNode(resNode, treeFilter);
                    });
                    return (
                        <div className='application-details'>
                        <Page
                            title='Application Details'
                            toolbar={{
                                filter,
                                breadcrumbs: [{title: 'Applications', path: '/applications' }, { title: this.props.match.params.name }],
                                actionMenu: {items: this.getApplicationActionMenu(application)},
                                tools: (
                                    <React.Fragment key='app-list-tools'>
                                        <div className='application-details__view-type'>
                                            <i className={classNames('fa fa-sitemap', {selected: pref.view === 'tree'})} onClick={() => {
                                                this.appContext.apis.navigation.goto('.', { view: 'tree' });
                                                services.viewPreferences.updatePreferences({ appDetails: {...pref, view: 'tree'} });
                                            }} />
                                            <i className={classNames('fa fa-th-list', {selected: pref.view === 'list'})} onClick={() => {
                                                this.appContext.apis.navigation.goto('.', { view: 'list' });
                                                services.viewPreferences.updatePreferences({ appDetails: {...pref, view: 'list'} });
                                            }} />
                                        </div>
                                    </React.Fragment>
                                ),
                            }}>
                            <div className='application-details__status-panel'>
                                <ApplicationStatusPanel application={application}
                                    refresh={async (hard) => {
                                        const [app, res] = await Promise.all([
                                            services.applications.get(this.props.match.params.name, hard ? 'hard' : 'normal'),
                                            services.applications.resourceTree(
                                                this.props.match.params.name).then((items) => resourcesFromSummaryInfo(application, items)),
                                        ]);
                                        await this.loader.setData({...this.loader.getData() || {}, application: app, resources: res });
                                    }}
                                    showOperation={() => this.setOperationStatusVisible(true)}
                                    showConditions={() => this.setConditionsStatusVisible(true)}/>
                            </div>
                            <div className='application-details__tree'>
                                {refreshing && <p className='application-details__refreshing-label'>Refreshing</p>}
                                {pref.view === 'tree' && (
                                    <ApplicationResourceTree
                                    nodeFilter={(node) => this.filterTreeNode(node, treeFilter)}
                                    selectedNodeFullName={this.selectedNodeKey}
                                    onNodeClick={(fullName) => this.selectNode(fullName)}
                                    nodeMenuItems={(node) => this.getResourceMenuItems(node, application)}
                                    resources={resources}
                                    app={application}
                                    onClearFilter={() => {
                                        this.appContext.apis.navigation.goto('.', { resource: '' } );
                                        services.viewPreferences.updatePreferences({ appDetails: { ...pref, resourceFilter: [] } });
                                    }}
                                    />
                                ) || (
                                    <div className='argo-container'>
                                        {filteredRes.length > 0 && (
                                            <Paginate page={this.state.page} data={filteredRes} onPageChange={(page) => this.setState({page})} preferencesKey='application-details'>
                                            {(data) => (
                                                <ApplicationResourceList
                                                    onNodeClick={(fullName) => this.selectNode(fullName)}
                                                    resources={data}
                                                    nodeMenuItems={(node) => this.getResourceMenuItems(node, application)}
                                                    />
                                                )}
                                            </Paginate>
                                        ) || (
                                            <EmptyState icon='search'>
                                                <h4>No resources found</h4>
                                                <h5>Try to change filter criteria</h5>
                                            </EmptyState>
                                        )}
                                    </div>
                                )}
                            </div>
                            <SlidingPanel isShown={selectedNode != null || isAppSelected} onClose={() => this.selectNode('')}>
                                <div>
                                {selectedNode && (
                                    <DataLoader noLoaderOnInputChange={true} input={selectedNode.resourceVersion} load={async () => {
                                        const managedResources = await services.applications.managedResources(application.metadata.name);
                                        const controlled = managedResources.find((item) => isSameNode(selectedNode, item));
                                        const summary = application.status.resources.find((item) => isSameNode(selectedNode, item));
                                        const controlledState = controlled && summary && { summary, state: controlled } || null;
                                        const liveState = await services.applications.getResource(application.metadata.name, selectedNode).catch(() => null);
                                        return { controlledState, liveState };

                                    }}>{(data) =>
                                        <Tabs navTransparent={true} tabs={this.getResourceTabs(application, selectedNode, data.liveState, [
                                                {title: 'SUMMARY', key: 'summary', content: (
                                                    <ApplicationNodeInfo application={application} live={data.liveState} controlled={data.controlledState} node={selectedNode}/>
                                                ),
                                            }])} />
                                    }</DataLoader>
                                )}
                                {isAppSelected && (
                                    <Tabs navTransparent={true} tabs={[{
                                        title: 'SUMMARY', key: 'summary', content: <ApplicationSummary app={application} updateApp={(app) => this.updateApp(app)}/>,
                                    }, {
                                        title: 'PARAMETERS', key: 'parameters', content: (
                                            <DataLoader key='appDetails' input={{
                                                repoURL: application.spec.source.repoURL,
                                                path: application.spec.source.path,
                                                targetRevision: application.spec.source.targetRevision,
                                            }} load={(src) =>
                                                services.repos.appDetails(src.repoURL, src.path, src.targetRevision)
                                                .catch(() => ({ type: 'Directory' as appModels.AppSourceType, path: application.spec.source.path }))}>
                                            {(details: appModels.RepoAppDetails) => <ApplicationParameters
                                                    save={(app) => services.applications.updateSpec(app.metadata.name, app.spec)} application={application} details={details} />}
                                            </DataLoader>
                                        ),
                                    }, {
                                        title: 'SPEC MANIFEST', key: 'manifest', content: (
                                            <YamlEditor minHeight={800} input={application.spec} onSave={async (patch) => {
                                                const spec = JSON.parse(JSON.stringify(application.spec));
                                                return services.applications.updateSpec(application.metadata.name, jsonMergePatch.apply(spec, JSON.parse(patch)));
                                            }}/>
                                        ),
                                    }, {
                                        title: 'EVENTS', key: 'event', content: <ApplicationResourceEvents applicationName={application.metadata.name}/>,
                                    }]}/>
                                )}
                                </div>
                            </SlidingPanel>
                            <SlidingPanel isMiddle={true} isShown={showDeployPanel} onClose={() => this.showDeploy(null)} header={(
                                    <div>
                                    <button className='argo-button argo-button--base' onClick={() => this.formApi.submitForm(null)}>
                                        Synchronize
                                    </button> <button onClick={() => this.showDeploy(null)} className='argo-button argo-button--base-o'>
                                        Cancel
                                    </button>
                                    </div>
                                )}>
                                {showDeployPanel && (
                                    <Form
                                        defaultValues={{
                                            revision: application.spec.source.targetRevision || 'HEAD',
                                            resources: resources.filter((item) => !item.hook).map((_, i) => i === deployResIndex || deployResIndex === -1),
                                        }}
                                        validateError={(values) => ({
                                            resources: values.resources.every((item: boolean) => !item) && 'Select at least one resource',
                                        })}
                                        onSubmit={(params: any) => this.syncApplication(params.revision, params.prune, params.dryRun, params.resources, resources)}
                                        getApi={(api) => this.formApi = api}>

                                        {(formApi) => (
                                            <form role='form' className='width-control' onSubmit={formApi.submitForm}>
                                                <h6>Synchronizing application manifests from <a href={application.spec.source.repoURL}>
                                                    {application.spec.source.repoURL}</a>
                                                </h6>
                                                <div className='argo-form-row'>
                                                    <FormField formApi={formApi} label='Revision' field='revision' component={Text}/>
                                                </div>

                                                <div className='argo-form-row'>
                                                    <div>
                                                        <span>
                                                            <Checkbox id='prune-on-sync-checkbox' field='prune'/> <label htmlFor='prune-on-sync-checkbox'>Prune</label>
                                                        </span> <span>
                                                            <Checkbox id='dry-run-checkbox' field='dryRun'/> <label htmlFor='dry-run-checkbox'>Dry Run</label>
                                                        </span>
                                                    </div>
                                                    <label>Synchronize resources:</label>
                                                    <div style={{float: 'right'}}>
                                                        <a onClick={() => formApi.setValue('resources', formApi.values.resources.map(() => true))}>all</a> / <a
                                                            onClick={() => formApi.setValue('resources', formApi.values.resources.map(() => false))}>none</a></div>
                                                    {!formApi.values.resources.every((item: boolean) => item) && (
                                                        <div className='application-details__warning'>WARNING: partial synchronization is not recorded in history</div>
                                                    )}
                                                    <div style={{paddingLeft: '1em'}}>
                                                    {resources.filter((item) => !item.hook).map((item, i) => {
                                                        const resKey = nodeKey(item);
                                                        return (
                                                            <div key={resKey}>
                                                                <Checkbox id={resKey} field={`resources[${i}]`}/> <label htmlFor={resKey}>
                                                                    {resKey} <AppUtils.ComparisonStatusIcon status={item.status}/></label>
                                                            </div>
                                                        );
                                                    })}
                                                    {formApi.errors.resources && (
                                                        <div className='argo-form-row__error-msg'>{formApi.errors.resources}</div>
                                                    )}
                                                    </div>
                                                </div>
                                            </form>
                                        )}
                                    </Form>
                                )}
                            </SlidingPanel>
                            <SlidingPanel isShown={this.selectedRollbackDeploymentIndex > -1} onClose={() => this.setRollbackPanelVisible(-1)}>
                                {<ApplicationDeploymentHistory
                                    app={application}
                                    selectedRollbackDeploymentIndex={this.selectedRollbackDeploymentIndex}
                                    rollbackApp={(info) => this.rollbackApplication(info)}
                                    selectDeployment={(i) => this.setRollbackPanelVisible(i)}
                                    />}
                            </SlidingPanel>
                            <SlidingPanel isShown={this.showOperationState && !!operationState} onClose={() => this.setOperationStatusVisible(false)}>
                                {operationState && <ApplicationOperationState  application={application} operationState={operationState}/>}
                            </SlidingPanel>
                            <SlidingPanel isShown={this.showConditions && !!conditions} onClose={() => this.setConditionsStatusVisible(false)}>
                                {conditions && <ApplicationConditions conditions={conditions}/>}
                            </SlidingPanel>
                        </Page>
                        </div>
                    );
                }}
            </DataLoader>)}
            </ObservableQuery>
        );
    }

    private getApplicationActionMenu(application: appModels.Application) {
        return [{
            iconClassName: 'icon fa fa-info-circle',
            title: 'Details',
            action: () => this.selectNode(nodeKey({
                group: 'argoproj.io', kind: application.kind, name: application.metadata.name, namespace: application.metadata.namespace })),
        }, {
            iconClassName: 'icon argo-icon-deploy',
            title: 'Sync',
            action: () => this.showDeploy('all'),
        }, {
            iconClassName: 'icon fa fa-history',
            title: 'History',
            action: () => this.setRollbackPanelVisible(0),
        }, {
            iconClassName: 'icon fa fa-times-circle',
            title: 'Delete',
            action: () => this.deleteApplication(),
        }];
    }

    private filterTreeNode(node: ResourceTreeNode, filter: {kind: string[], health: string[], sync: string[]}): boolean {
        const syncStatuses = filter.sync.map((item) => item === 'OutOfSync' ? ['OutOfSync', 'Unknown'] : [item] ).reduce(
            (first, second) => first.concat(second), []);
        const healthStatuses = filter.health.map((item) => item === 'Unhealthy' ? ['Unknown', 'Progressing', 'Degraded', 'Missing'] : [item] ).reduce(
            (first, second) => first.concat(second), []);

        return (filter.kind.length === 0 || filter.kind.indexOf(node.kind) > -1) &&
                (syncStatuses.length === 0 || node.root.hook ||  node.root.status && syncStatuses.indexOf(node.root.status) > -1) &&
                (healthStatuses.length === 0 || node.root.hook || node.root.health && healthStatuses.indexOf(node.root.health.status) > -1);
    }

    private loadAppInfo(name: string): Observable<{application: appModels.Application, resources: ResourceTreeNode[]}> {
        return Observable.merge(
            Observable.fromPromise(
                services.applications.get(name).
                catch((e) => {
                    if (e.status === 404) {
                        this.onAppDeleted();
                    }
                    throw e;
                }).
                then((application) => ({application, resources: resourcesFromSummaryInfo(application, [])})),
            ),
            services.applications.watch({name: this.props.match.params.name})
                .do((changeEvent) => {
                    if (changeEvent.type === 'DELETED') {
                        this.onAppDeleted();
                    }
                }).map((changeEvent) => changeEvent.application).flatMap((application) => Observable.fromPromise(
                    services.applications.resourceTree(application.metadata.name).then(
                        (resources) => ({application, resources: resourcesFromSummaryInfo(application, resources)}),
                )),
        ).repeat().retryWhen((errors) => errors.delay(500)));
    }

    private onAppDeleted() {
        this.appContext.apis.notifications.show({ type: NotificationType.Success, content: `Application '${this.props.match.params.name}' was deleted` });
        this.appContext.apis.navigation.goto('/applications');
    }

    private async updateApp(app: appModels.Application) {
        try {
            await services.applications.updateSpec(app.metadata.name, app.spec);
            const [updatedApp, resources] = await Promise.all([
                services.applications.get(app.metadata.name), services.applications.resourceTree(app.metadata.name).catch(() => [])]);
            this.loader.setData({...this.loader.getData() || {}, application: updatedApp, resources: resourcesFromSummaryInfo(app, resources)});
        } catch (e) {
            this.appContext.apis.notifications.show({
                content: <ErrorNotification title='Unable to update application' e={e}/>,
                type: NotificationType.Error,
            });
        }
    }

    private groupAppNodesByKey(application: appModels.Application, resources: ResourceTreeNode[]) {
        const nodeByKey = new Map<string, appModels.ResourceDiff | appModels.ResourceNode | appModels.Application>();
        function addChildren<T extends (appModels.ResourceNode | appModels.ResourceDiff) & { key: string, children: appModels.ResourceNode[] }>(node: T) {
            nodeByKey.set(node.key, node);
            for (const child of (node.children || [])) {
                addChildren({...child, key: nodeKey(child)});
            }
        }

        if (application) {
            nodeByKey.set(nodeKey({
                group: 'argoproj.io', kind: application.kind, name: application.metadata.name, namespace: application.metadata.namespace,
            }), application);
            for (const node of (resources || [])) {
                addChildren({...node, children: node.children, key: nodeKey(node)});
            }
        }
        return nodeByKey;
    }

    private getTreeFilter(filter: string[]): {kind: string[], health: string[], sync: string[]} {
        const kind = new Array<string>();
        const health = new Array<string>();
        const sync = new Array<string>();
        for (const item of filter) {
            const [type, val] = item.split(':');
            switch (type) {
                case 'kind':
                    kind.push(val);
                    break;
                case 'health':
                    health.push(val);
                    break;
                case 'sync':
                    sync.push(val);
                    break;
            }
        }
        return {kind, health, sync};
    }

    private showDeploy(resource: string) {
        this.appContext.apis.navigation.goto('.', { deploy: resource });
    }

    private setOperationStatusVisible(isVisible: boolean) {
        this.appContext.apis.navigation.goto('.', { operation: isVisible });
    }

    private setConditionsStatusVisible(isVisible: boolean) {
        this.appContext.apis.navigation.goto('.', { conditions: isVisible });
    }

    private setRollbackPanelVisible(selectedDeploymentIndex = 0) {
        this.appContext.apis.navigation.goto('.', { rollback: selectedDeploymentIndex });
    }

    private selectNode(fullName: string, containerIndex = 0) {
        const node = fullName ? `${fullName}:${containerIndex}` : null;
        this.appContext.apis.navigation.goto('.', { node });
    }

    private async syncApplication(revision: string, prune: boolean, dryRun: boolean, selectedResources: boolean[], appResources: appModels.ResourceNode[]) {
        let resources = selectedResources && appResources.filter((_, i) => selectedResources[i]).map((item) => {
            return {
                group: item.group,
                kind: item.kind,
                name: item.name,
            };
        }) || null;
        // Don't specify resources filter if user selected all resources
        if (resources && resources.length === appResources.length) {
            resources = null;
        }
        await AppUtils.syncApplication(this.props.match.params.name, revision, prune, dryRun, resources, this.appContext.apis);
        this.showDeploy(null);
    }

    private async rollbackApplication(revisionHistory: appModels.RevisionHistory) {
        try {
            const confirmed = await this.appContext.apis.popup.confirm('Rollback application', `Are you sure you want to rollback application '${this.props.match.params.name}'?`);
            if (confirmed) {
                await services.applications.rollback(this.props.match.params.name, revisionHistory.id);
            }
            this.setRollbackPanelVisible(-1);
        } catch (e) {
            this.appContext.apis.notifications.show({
                content: <ErrorNotification title='Unable to rollback application' e={e}/>,
                type: NotificationType.Error,
            });
        }
    }

    private get appContext(): AppContext {
        return this.context as AppContext;
    }

    private getResourceMenuItems(resource: appModels.ResourceNode, application: appModels.Application): MenuItem[] {
        if (AppUtils.isAppNode(resource) && resource.name === application.metadata.name) {
            return this.getApplicationActionMenu(application);
        }

        return [{
            title: 'Details',
            action: () => this.selectNode(nodeKey(resource)),
        }, {
            title: 'Sync',
            action: () => this.showDeploy(nodeKey(resource)),
        }, {
            title: 'Delete',
            action: async () => {
                this.appContext.apis.popup.prompt('Delete resource',
                () => (
                    <div>
                        <p>Are your sure you want to delete {resource.kind} '{resource.name}'?`</p>
                        <div className='argo-form-row' style={{paddingLeft: '30px'}}>
                            <Checkbox id='force-delete-checkbox' field='force'/> <label htmlFor='force-delete-checkbox'>Force delete</label>
                        </div>
                    </div>
                ),
                {
                    submit: async (vals, _, close) => {
                        try {
                            await services.applications.deleteResource(this.props.match.params.name, resource, !!vals.force);
                            close();
                        } catch (e) {
                            this.appContext.apis.notifications.show({
                                content: <ErrorNotification title='Unable to delete resource' e={e}/>,
                                type: NotificationType.Error,
                            });
                        }
                    },
                });
            },
        }];
    }

    private async deleteApplication() {
        await AppUtils.deleteApplication(this.props.match.params.name, this.appContext.apis);
    }

    private getResourceTabs(application: appModels.Application, node: ResourceTreeNode, state: appModels.State, tabs: Tab[]) {
        if (state) {
            tabs.push({
                title: 'EVENTS', key: 'events', content: (
                <ApplicationResourceEvents applicationName={this.props.match.params.name} resource={{
                    name: state.metadata.name,
                    namespace: state.metadata.namespace,
                    uid: state.metadata.uid,
                }}/>),
            });
        }
        if (node.kind === 'Pod' && state) {
            const containerGroups = [{
                offset: 0,
                title: 'INIT CONTAINERS',
                containers: state.spec.initContainers || [],
            }, {
                offset: (state.spec.initContainers || []).length,
                title: 'CONTAINERS',
                containers: state.spec.containers || [],
            }];
            tabs = tabs.concat([{
                key: 'logs',
                title: 'LOGS',
                content: (
                    <div className='application-details__tab-content-full-height'>
                        <div className='row'>
                            <div className='columns small-3 medium-2'>
                                {containerGroups.map((group) => (
                                    <div key={group.title} style={{marginBottom: '1em'}}>
                                        {group.containers.length > 0 && <p>{group.title}:</p>}
                                        {group.containers.map((container: any, i: number) => (
                                            <div className='application-details__container' key={container.name} onClick={() => this.selectNode(
                                                    this.selectedNodeKey, group.offset + i)}>
                                                {(group.offset + i) === this.selectedNodeInfo.container && <i className='fa fa-angle-right'/>}
                                                <span title={container.name}>{container.name}</span>
                                            </div>
                                        ))}
                                    </div>
                                ))}
                            </div>
                            <div className='columns small-9 medium-10'>
                                <PodsLogsViewer
                                    pod={state} applicationName={application.metadata.name} containerIndex={this.selectedNodeInfo.container} />
                            </div>
                        </div>
                    </div>
                ),
            }]);
        }
        return tabs;
    }
}
