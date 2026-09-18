import { Switch, Route, useRoute, useLocation } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";
import Home from "@/pages/home";
import AdminSchedule from "@/pages/admin-schedule";
import CoachView from "@/pages/coach-view";
import Statistics from "@/pages/statistics";
import VenueSchedule from "@/pages/venue-schedule";
import VenueScheduleEdit from "@/pages/venue-schedule-edit";
import TeacherPortal from "@/pages/teacher-portal";
import MultiSchoolAdmin from "@/pages/multi-school-admin";
import CoachPortal from "@/pages/coach-portal";
import CoachApproval from "@/pages/coach-approval";
import CoachAssignment from "@/pages/coach-assignment";
import WeeklyPush from "@/pages/weekly-push";
import Sop from "@/pages/sop";
import ItGovernance from "@/pages/it-governance";
import SchoolView from "@/pages/school-view";
import PasswordProtect from "@/components/password-protect";

// Single password gate for the entire admin area.
// All /mgt-x9k7p2/* routes are rendered inside this component,
// so the user is asked for the password exactly once per session.
function AdminSection() {
  const [matched] = useRoute("/mgt-x9k7p2/:rest*");
  if (!matched) return null;
  return (
    <PasswordProtect>
      <Switch>
        <Route path="/mgt-x9k7p2/schedule" component={AdminSchedule} />
        <Route path="/mgt-x9k7p2/class-edit" component={VenueScheduleEdit} />
        <Route path="/mgt-x9k7p2/assign" component={CoachAssignment} />
        <Route path="/mgt-x9k7p2/stats" component={Statistics} />
        <Route path="/mgt-x9k7p2/approval" component={CoachApproval} />
        <Route path="/mgt-x9k7p2/weekly-push" component={WeeklyPush} />
        <Route path="/mgt-x9k7p2/sop" component={Sop} />
        <Route path="/mgt-x9k7p2/it-governance" component={ItGovernance} />
        <Route component={NotFound} />
      </Switch>
    </PasswordProtect>
  );
}

function CoachAssignmentRedirect() {
  const [, navigate] = useLocation();
  useEffect(() => navigate("/mgt-x9k7p2/assign", { replace: true }), [navigate]);
  return null;
}

function ProtectedMultiSchoolAdmin() {
  return <PasswordProtect><MultiSchoolAdmin /></PasswordProtect>;
}

function Router() {
  return (
    <Switch>
      {/* Public pages - no authentication required */}
      <Route path="/" component={CoachPortal} />
      <Route path="/coach" component={CoachView} />
      <Route path="/venue-schedule" component={VenueSchedule} />
      
      {/* Multi-school teacher portal */}
      <Route path="/teacher-portal" component={TeacherPortal} />
      <Route path="/teacher/:schoolCode" component={TeacherPortal} />
      
      {/* Multi-school admin */}
      <Route path="/multi-school-admin" component={ProtectedMultiSchoolAdmin} />
      
      {/* Individual school/venue public pages */}
      <Route path="/school/:venueName" component={SchoolView} />
      
      {/* Coach portal (front-end for coaches) */}
      <Route path="/coach-portal" component={CoachPortal} />
      
      {/* Admin area — single password gate for all /mgt-x9k7p2/* routes */}
      <Route path="/mgt-x9k7p2/coach-assign" component={CoachAssignmentRedirect} />
      <Route path="/mgt-x9k7p2/coach-assignment" component={CoachAssignmentRedirect} />
      <Route path="/mgt-x9k7p2/:rest*" component={AdminSection} />
      
      {/* Auth pages */}
      <Route path="/home" component={Home} />
      <Route path="/landing" component={Landing} />
      
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
