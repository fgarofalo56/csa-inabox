/**
 * Side-effect module: registers the observed-inventory findings source with the
 * environments feature (the single registration call W1-3 owns). Import once from
 * any route that runs findings or a sync.
 */
import { registerFindingsSource } from '../environments/deps';
import { cosmosObservedRepo } from './deps';
import { observedFindingsSource } from './findings-source';

registerFindingsSource(observedFindingsSource(cosmosObservedRepo));
