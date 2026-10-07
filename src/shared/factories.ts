// Build schema-valid objects from partial input: zod fills every defaulted field (effects, transitions, ...).
import { LayerSchema, ProjectSchema, SceneSchema, type Layer, type LayerInput, type Project, type ProjectInput, type Scene, type SceneInput } from './schema';

export const makeLayer = <T extends LayerInput>(input: T): Extract<Layer, { type: T['type'] }> =>
  LayerSchema.parse(input) as Extract<Layer, { type: T['type'] }>;

export const makeScene = (input: SceneInput): Scene => SceneSchema.parse(input);

export const makeProject = (input: ProjectInput): Project => ProjectSchema.parse(input);
