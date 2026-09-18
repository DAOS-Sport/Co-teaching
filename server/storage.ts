/**
 * Storage façade.
 *
 * After the Task #22 refactor every actual DB operation lives in a
 * dedicated repository under `server/repositories/`. This file exposes
 * the long-standing `IStorage` interface and the singleton `storage`
 * export so existing imports (`import { storage } from "./storage"`)
 * keep working. Each method on `DatabaseStorage` is a thin one-line
 * delegate to the right repository.
 *
 * When adding a new operation: put the implementation in the repository
 * for the relevant domain, expose it on `IStorage`, and add a one-line
 * delegate here.
 */
import {
  type User,
  type UpsertUser,
  type Venue,
  type TimeSlot,
  type Schedule,
  type InsertScheduleType,
  type CoachRegistration,
  type InsertCoachRegistrationType,
  type CoachUser,
  type InsertCoachUserType,
  type VenueInfo,
  type CoachAvailability,
  type CoachVenuePreference,
  type LineNotifyLog,
  type InsertLineNotifyLog,
} from "@shared/schema";

import { VenueRepository } from "./repositories/venue.repository";
import {
  ScheduleRepository,
  type ScheduleUpdateFields,
} from "./repositories/schedule.repository";
import { CoachRepository } from "./repositories/coach.repository";
import { SettingsRepository } from "./repositories/settings.repository";
import { NotifyRepository } from "./repositories/notify.repository";

export interface IStorage {
  // User operations (mandatory for Replit Auth)
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;

  // Venue operations
  getVenues(): Promise<Venue[]>;
  initializeVenues(): Promise<void>;
  createVenue(name: string, color: string): Promise<Venue>;
  deleteVenue(id: string): Promise<void>;

  // Time slot operations
  getTimeSlots(): Promise<TimeSlot[]>;
  initializeTimeSlots(): Promise<void>;

  // Schedule operations
  getSchedulesByDate(
    date: string
  ): Promise<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]>;
  getSchedulesByDateRange(
    startDate: string,
    endDate: string
  ): Promise<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]>;
  getVacantSchedules(
    venueId: string,
    startDate: string,
    endDate: string
  ): Promise<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]>;
  upsertSchedule(schedule: InsertScheduleType): Promise<Schedule>;
  copyWeekIntoEmptyCells(input: Parameters<ScheduleRepository["copyWeekIntoEmptyCells"]>[0]): ReturnType<ScheduleRepository["copyWeekIntoEmptyCells"]>;
  updateSchedule(id: string, updateData: ScheduleUpdateFields): Promise<Schedule>;
  deleteSchedule(id: string): Promise<void>;
  getCoachSchedules(
    coachName: string,
    startDate: string,
    endDate: string
  ): Promise<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]>;
  getScheduleById(id: string): Promise<Schedule | undefined>;
  getConflicts(
    date: string
  ): Promise<{ coachName: string; timeSlotId: string; venues: string[] }[]>;

  // Coach registration operations
  getSchedulesWithoutCoach(): Promise<
    (Schedule & {
      venue: Venue;
      timeSlot: TimeSlot;
      registrations: CoachRegistration[];
    })[]
  >;
  getSchedulesWithoutCoachByDateRange(
    startDate: string,
    endDate: string
  ): Promise<
    (Schedule & {
      venue: Venue;
      timeSlot: TimeSlot;
      registrations: CoachRegistration[];
    })[]
  >;
  registerCoachForSchedule(
    registration: InsertCoachRegistrationType
  ): Promise<CoachRegistration>;
  getCoachRegistrations(scheduleId: string): Promise<CoachRegistration[]>;
  getCoachStatistics(
    startDate: string,
    endDate: string,
    coachName?: string
  ): Promise<
    {
      coachName: string;
      totalClasses: number;
      teachingClasses: number;
      assistClasses: number;
      venueBreakdown: { venueName: string; count: number; color: string }[];
    }[]
  >;
  getUniqueCoaches(): Promise<string[]>;

  // Coach user operations (LINE-based)
  getCoachUserByLineId(lineId: string): Promise<CoachUser | undefined>;
  getCoachUserById(id: string): Promise<CoachUser | undefined>;
  createCoachUser(data: InsertCoachUserType): Promise<CoachUser>;
  updateCoachUserStatus(id: string, status: string): Promise<CoachUser>;
  updateCoachUserLineId(id: string, lineId: string): Promise<CoachUser | undefined>;
  clearCoachUserLineId(id: string): Promise<CoachUser | undefined>;
  updateCoachUserName(id: string, name: string): Promise<CoachUser | undefined>;
  updateCoachEmployeeId(
    id: string,
    employeeId: string
  ): Promise<CoachUser | undefined>;
  getAllCoachUsers(): Promise<CoachUser[]>;
  getPendingCoachUsers(): Promise<CoachUser[]>;
  getApprovedCoachUsers(): Promise<CoachUser[]>;
  getColleaguesForCoach(
    coachName: string,
    date: string,
    venueIds: string[]
  ): Promise<{ name: string; phone: string | null }[]>;

  // System settings
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  // Venue info
  getAllVenueInfos(): Promise<VenueInfo[]>;
  getVenueInfo(venueName: string): Promise<VenueInfo | undefined>;
  upsertVenueInfo(
    venueName: string,
    videoUrl: string | null,
    description: string | null,
    mapUrl?: string | null
  ): Promise<VenueInfo>;

  // Schedule locking (two-phase scheduling)
  lockSchedules(
    venueId: string,
    startDate: string,
    endDate: string
  ): Promise<void>;
  unlockSchedules(
    venueId: string,
    startDate: string,
    endDate: string
  ): Promise<void>;
  assignCoach(scheduleId: string, coachName: string | null): Promise<Schedule>;
  getScheduleLockStatus(
    venueId: string,
    startDate: string,
    endDate: string
  ): Promise<boolean>;

  // Coach availability
  getCoachAvailabilityByWeek(weekStart: string): Promise<CoachAvailability[]>;
  getCoachAvailabilityForCoach(
    coachName: string,
    weekStart: string
  ): Promise<CoachAvailability[]>;
  upsertCoachAvailability(
    coachName: string,
    weekStart: string,
    slots: { dayOfWeek: number; timeSlotOrder: number }[]
  ): Promise<void>;

  // Coach venue preferences
  getCoachVenuePreferences(coachName: string): Promise<CoachVenuePreference[]>;
  getAllCoachVenuePreferences(): Promise<CoachVenuePreference[]>;
  setCoachVenuePreferences(
    coachName: string,
    venueNames: string[]
  ): Promise<void>;
  getCoachFillStatus(
    coachName: string
  ): Promise<{ availabilitySlots: number; venuePrefsCount: number }>;

  // LINE notify logs
  getNotifyLogsByDate(date: string): Promise<LineNotifyLog[]>;
  insertNotifyLog(log: InsertLineNotifyLog): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  private readonly venueRepo = new VenueRepository();
  private readonly scheduleRepo = new ScheduleRepository();
  private readonly coachRepo = new CoachRepository();
  private readonly settingsRepo = new SettingsRepository();
  private readonly notifyRepo = new NotifyRepository();

  // ── Users (auth) ──────────────────────────────────────────────
  getUser = (id: string) => this.settingsRepo.getUser(id);
  upsertUser = (userData: UpsertUser) => this.settingsRepo.upsertUser(userData);

  // ── Venues / time slots / venue info ─────────────────────────
  getVenues = () => this.venueRepo.getVenues();
  initializeVenues = () => this.venueRepo.initializeVenues();
  createVenue = (name: string, color: string) =>
    this.venueRepo.createVenue(name, color);
  deleteVenue = (id: string) => this.venueRepo.deleteVenue(id);
  getTimeSlots = () => this.venueRepo.getTimeSlots();
  initializeTimeSlots = () => this.venueRepo.initializeTimeSlots();
  getAllVenueInfos = () => this.venueRepo.getAllVenueInfos();
  getVenueInfo = (venueName: string) => this.venueRepo.getVenueInfo(venueName);
  upsertVenueInfo = (
    venueName: string,
    videoUrl: string | null,
    description: string | null,
    mapUrl?: string | null
  ) => this.venueRepo.upsertVenueInfo(venueName, videoUrl, description, mapUrl);

  // ── Schedules + locking + statistics + conflicts ─────────────
  getSchedulesByDate = (date: string) =>
    this.scheduleRepo.getSchedulesByDate(date);
  getSchedulesByDateRange = (startDate: string, endDate: string) =>
    this.scheduleRepo.getSchedulesByDateRange(startDate, endDate);
  getVacantSchedules = (venueId: string, startDate: string, endDate: string) =>
    this.scheduleRepo.getVacantSchedules(venueId, startDate, endDate);
  upsertSchedule = (schedule: InsertScheduleType) =>
    this.scheduleRepo.upsertSchedule(schedule);
  copyWeekIntoEmptyCells = (input: Parameters<ScheduleRepository["copyWeekIntoEmptyCells"]>[0]) =>
    this.scheduleRepo.copyWeekIntoEmptyCells(input);
  getScheduleById = (id: string) => this.scheduleRepo.getScheduleById(id);
  updateSchedule = (id: string, updateData: ScheduleUpdateFields) =>
    this.scheduleRepo.updateSchedule(id, updateData);
  deleteSchedule = (id: string) => this.scheduleRepo.deleteSchedule(id);
  getCoachSchedules = (coachName: string, startDate: string, endDate: string) =>
    this.scheduleRepo.getCoachSchedules(coachName, startDate, endDate);
  getConflicts = (date: string) => this.scheduleRepo.getConflicts(date);
  getCoachStatistics = (
    startDate: string,
    endDate: string,
    coachName?: string
  ) => this.scheduleRepo.getCoachStatistics(startDate, endDate, coachName);
  getUniqueCoaches = () => this.scheduleRepo.getUniqueCoaches();
  getSchedulesWithoutCoach = () =>
    this.scheduleRepo.getSchedulesWithoutCoach();
  getSchedulesWithoutCoachByDateRange = (startDate: string, endDate: string) =>
    this.scheduleRepo.getSchedulesWithoutCoachByDateRange(startDate, endDate);
  registerCoachForSchedule = (
    registration: InsertCoachRegistrationType
  ) => this.scheduleRepo.registerCoachForSchedule(registration);
  getCoachRegistrations = (scheduleId: string) =>
    this.scheduleRepo.getCoachRegistrations(scheduleId);
  lockSchedules = (venueId: string, startDate: string, endDate: string) =>
    this.scheduleRepo.lockSchedules(venueId, startDate, endDate);
  unlockSchedules = (venueId: string, startDate: string, endDate: string) =>
    this.scheduleRepo.unlockSchedules(venueId, startDate, endDate);
  assignCoach = (scheduleId: string, coachName: string | null) =>
    this.scheduleRepo.assignCoach(scheduleId, coachName);
  getScheduleLockStatus = (
    venueId: string,
    startDate: string,
    endDate: string
  ) => this.scheduleRepo.getScheduleLockStatus(venueId, startDate, endDate);

  // ── Coach users + availability + venue prefs + colleagues ────
  getCoachUserByLineId = (lineId: string) =>
    this.coachRepo.getCoachUserByLineId(lineId);
  getCoachUserById = (id: string) => this.coachRepo.getCoachUserById(id);
  createCoachUser = (data: InsertCoachUserType) =>
    this.coachRepo.createCoachUser(data);
  updateCoachUserStatus = (id: string, status: string) =>
    this.coachRepo.updateCoachUserStatus(id, status);
  updateCoachUserLineId = (id: string, lineId: string) =>
    this.coachRepo.updateCoachUserLineId(id, lineId);
  clearCoachUserLineId = (id: string) =>
    this.coachRepo.clearCoachUserLineId(id);
  updateCoachUserName = (id: string, name: string) =>
    this.coachRepo.updateCoachUserName(id, name);
  updateCoachEmployeeId = (id: string, employeeId: string) =>
    this.coachRepo.updateCoachEmployeeId(id, employeeId);
  getAllCoachUsers = () => this.coachRepo.getAllCoachUsers();
  getPendingCoachUsers = () => this.coachRepo.getPendingCoachUsers();
  getApprovedCoachUsers = () => this.coachRepo.getApprovedCoachUsers();
  getColleaguesForCoach = (
    coachName: string,
    date: string,
    venueIds: string[]
  ) =>
    this.coachRepo.getColleaguesForCoach(coachName, date, venueIds);
  getCoachAvailabilityByWeek = (weekStart: string) =>
    this.coachRepo.getCoachAvailabilityByWeek(weekStart);
  getCoachAvailabilityForCoach = (coachName: string, weekStart: string) =>
    this.coachRepo.getCoachAvailabilityForCoach(coachName, weekStart);
  upsertCoachAvailability = (
    coachName: string,
    weekStart: string,
    slots: { dayOfWeek: number; timeSlotOrder: number }[]
  ) => this.coachRepo.upsertCoachAvailability(coachName, weekStart, slots);
  getCoachVenuePreferences = (coachName: string) =>
    this.coachRepo.getCoachVenuePreferences(coachName);
  getAllCoachVenuePreferences = () =>
    this.coachRepo.getAllCoachVenuePreferences();
  setCoachVenuePreferences = (coachName: string, venueNames: string[]) =>
    this.coachRepo.setCoachVenuePreferences(coachName, venueNames);
  getCoachFillStatus = (coachName: string) =>
    this.coachRepo.getCoachFillStatus(coachName);

  // ── LINE notify logs ─────────────────────────────────────────
  getNotifyLogsByDate = (date: string) =>
    this.notifyRepo.getNotifyLogsByDate(date);
  insertNotifyLog = (log: InsertLineNotifyLog) =>
    this.notifyRepo.insertNotifyLog(log);

  // ── System settings ──────────────────────────────────────────
  getSetting = (key: string) => this.settingsRepo.getSetting(key);
  setSetting = (key: string, value: string) =>
    this.settingsRepo.setSetting(key, value);
}

export const storage = new DatabaseStorage();
