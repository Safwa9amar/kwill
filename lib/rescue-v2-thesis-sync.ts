/**
 * The thesis ids behind the student's rescue projects (plan A9 step 5b, P-66). A push or a focus uses these to re-read a thesis that a
 * repair may have changed. Only a project with a thesis has one: a diagnosis has none.
 */
import { listRescueProjects } from "@/lib/rescue-v2-api";

export async function rescueThesisIds(projectId?: string): Promise<string[]> {
  const { projects } = await listRescueProjects();
  return projects
    .filter((p) => (projectId === undefined || p.id === projectId) && p.thesisId)
    .map((p) => p.thesisId as string);
}
